import { createAPIFileRoute } from "@tanstack/start/api";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

type ApiHandlerContext = {
  request: Request;
};

type AuthenticatedRequestContext = {
  supabase: SupabaseClient;
  user: User;
  token: string;
  requestUrl: URL;
  clientIp: string;
};

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      response: Response;
    };

type AuthResult =
  | {
      ok: true;
      context: AuthenticatedRequestContext;
    }
  | {
      ok: false;
      response: Response;
    };

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type InputSequenceEntry = {
  sequence: number;
  updatedAt: number;
};

type BrowserApiRouteState = {
  rateLimits: Map<string, RateLimitEntry>;
  queues: Map<string, Promise<void>>;
  inputSequences: Map<string, InputSequenceEntry>;
  lastPrunedAt: number;
};

type ControlMode = "agent" | "human" | "requested";

type RequestedMode = "agent" | "human";

type Pagination = {
  limit: number;
  offset: number;
};

type SessionListItem = {
  id: string;
  control_mode: ControlMode;
  status: string;
  created_at: string | null;
};

type SessionMetadataRow = {
  id: string;
  control_mode: ControlMode;
  status: string;
};

type SessionFrameRow = {
  id: string;
  cdp_url: string;
  control_mode: ControlMode;
  status: string;
};

type ControlSessionRow = {
  id: string;
  job_id: string;
  agent_busy: boolean;
  control_mode: ControlMode;
  status: string;
};

type ControlModeUpdateRow = {
  id: string;
  control_mode: ControlMode;
};

type ViewportDimensions = {
  width: number;
  height: number;
};

type MouseButton = "none" | "left" | "middle" | "right" | "back" | "forward";

type MouseInputType = "mousePressed" | "mouseReleased" | "mouseMoved";

type WheelInputType = "mouseWheel";

type KeyInputType = "keyDown" | "keyUp";

type SanitizedMouseInput = {
  kind: "mouse";
  type: MouseInputType;
  x: number;
  y: number;
  button: MouseButton;
  clickCount: number;
  modifiers: number;
};

type SanitizedWheelInput = {
  kind: "wheel";
  type: WheelInputType;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  button: "none";
  clickCount: 0;
  modifiers: number;
};

type SanitizedKeyInput = {
  kind: "key";
  type: KeyInputType;
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
};

type SanitizedTextInput = {
  kind: "text";
  text: string;
};

type SanitizedBrowserInput = SanitizedMouseInput | SanitizedWheelInput | SanitizedKeyInput | SanitizedTextInput;

type ParsedInputPostBody = {
  kind: "input";
  id: string;
  input: SanitizedBrowserInput;
  sequence: number | null;
};

type ParsedModePostBody = {
  kind: "mode";
  id: string;
  mode: RequestedMode;
};

type ParsedPostBody = ParsedInputPostBody | ParsedModePostBody;

type BrowserCommand = (cdpUrl: string, command: "frame" | "input", payload?: SanitizedBrowserInput) => Promise<unknown>;

type PostOperatorMessage = (jobId: string, message: string) => Promise<unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON_BODY_BYTES = 32768;
const MAX_TEXT_INPUT_LENGTH = 10000;
const MAX_KEY_STRING_LENGTH = 40;
const MAX_COORDINATE_BEFORE_VIEWPORT_CHECK = 1000000;
const MAX_WHEEL_DELTA = 10000;
const MAX_VIEWPORT_DIMENSION = 100000;
const INPUT_SEQUENCE_TTL_MS = 3600000;
const OPERATOR_HANDOFF_MESSAGE = "A felhasználó visszaadta a böngésző irányítását. Vizsgáld meg az aktuális oldalt, és onnan folytasd; ne ismételd meg a már elvégzett műveleteket.";
const MOUSE_BUTTON_VALUES: readonly MouseButton[] = ["none", "left", "middle", "right", "back", "forward"];
const ACTIVE_STATUS = "active";

export const APIRoute = createAPIFileRoute("/api/browser")({
  GET: async ({ request }: ApiHandlerContext): Promise<Response> => {
    try {
      return await handleGetRequest(request);
    } catch {
      return errorResponse("Váratlan kiszolgálóhiba történt.", 500);
    }
  },
  POST: async ({ request }: ApiHandlerContext): Promise<Response> => {
    try {
      return await handlePostRequest(request);
    } catch {
      return errorResponse("Váratlan kiszolgálóhiba történt.", 500);
    }
  },
});

async function handleGetRequest(request: Request): Promise<Response> {
  const requestUrl = getRequestUrl(request);
  const authentication = await authenticateRequest(request, requestUrl);

  if (!authentication.ok) {
    return authentication.response;
  }

  const query = requestUrl.searchParams;

  if (query.has("conversation")) {
    const conversation = query.get("conversation");

    if (conversation === null || !isValidUuid(conversation)) {
      return errorResponse("Érvénytelen beszélgetés.", 400);
    }

    const pagination = parsePagination(query);

    if (!pagination.ok) {
      return pagination.response;
    }

    const rateLimit = checkRateLimit(`get:conversation:${authentication.context.user.id}:${conversation}`, 120, 60000);

    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfterSeconds);
    }

    return await getConversationSessions(authentication.context, conversation, pagination.value);
  }

  const id = query.get("id") ?? "";

  if (!isValidUuid(id)) {
    return errorResponse("Érvénytelen böngészőnézet.", 400);
  }

  if (query.has("frame")) {
    const rateLimit = checkRateLimit(`get:frame:${authentication.context.user.id}:${id}`, 180, 60000);

    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfterSeconds);
    }

    return await getSessionFrame(authentication.context, id);
  }

  const rateLimit = checkRateLimit(`get:metadata:${authentication.context.user.id}:${id}`, 300, 60000);

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfterSeconds);
  }

  return await getSessionMetadata(authentication.context, id);
}

async function handlePostRequest(request: Request): Promise<Response> {
  const requestUrl = getRequestUrl(request);
  const originValidationResponse = validatePostOrigin(request, requestUrl);

  if (originValidationResponse !== null) {
    return originValidationResponse;
  }

  const authentication = await authenticateRequest(request, requestUrl);

  if (!authentication.ok) {
    return authentication.response;
  }

  const body = await readJsonBody(request);

  if (!body.ok) {
    return body.response;
  }

  const parsedBody = parsePostRequestBody(body.value);

  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  if (parsedBody.value.kind === "input") {
    const rateLimit = checkRateLimit(`post:input:${authentication.context.user.id}:${parsedBody.value.id}`, 900, 60000);

    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfterSeconds);
    }

    return await withSessionQueue(parsedBody.value.id, async () => await handleInputPost(authentication.context, parsedBody.value));
  }

  const modeRateLimit = checkRateLimit(`post:mode:${authentication.context.user.id}:${parsedBody.value.id}:${parsedBody.value.mode}`, parsedBody.value.mode === "agent" ? 20 : 60, 60000);

  if (!modeRateLimit.allowed) {
    return rateLimitResponse(modeRateLimit.retryAfterSeconds);
  }

  return await withSessionQueue(parsedBody.value.id, async () => await handleModePost(authentication.context, parsedBody.value));
}

async function getConversationSessions(context: AuthenticatedRequestContext, conversation: string, pagination: Pagination): Promise<Response> {
  const result = await context.supabase
    .from("chat_browser_sessions")
    .select("id,control_mode,status,created_at,chat_jobs!inner(conversation_id)", { count: "exact" })
    .eq("chat_jobs.conversation_id", conversation)
    .order("created_at", { ascending: false })
    .range(pagination.offset, pagination.offset + pagination.limit - 1);

  if (result.error) {
    return databaseErrorResponse();
  }

  const sessions = parseSessionListRows(result.data as unknown);

  if (sessions === null) {
    return databaseErrorResponse();
  }

  const total = typeof result.count === "number" ? result.count : null;

  return jsonResponse({
    sessions,
    pagination: {
      limit: pagination.limit,
      offset: pagination.offset,
      total,
      hasMore: total === null ? sessions.length === pagination.limit : pagination.offset + sessions.length < total,
    },
  });
}

async function getSessionMetadata(context: AuthenticatedRequestContext, id: string): Promise<Response> {
  const result = await context.supabase.from("chat_browser_sessions").select("id,control_mode,status").eq("id", id).maybeSingle();

  if (result.error) {
    return databaseErrorResponse();
  }

  if (result.data === null) {
    return errorResponse("A böngészőnézet nem található.", 404);
  }

  const session = parseSessionMetadataRow(result.data as unknown);

  if (session === null) {
    return databaseErrorResponse();
  }

  return jsonResponse({
    id: session.id,
    control_mode: session.control_mode,
    status: session.status,
  });
}

async function getSessionFrame(context: AuthenticatedRequestContext, id: string): Promise<Response> {
  const result = await context.supabase.from("chat_browser_sessions").select("id,cdp_url,control_mode,status").eq("id", id).maybeSingle();

  if (result.error) {
    return databaseErrorResponse();
  }

  if (result.data === null) {
    return errorResponse("A böngészőnézet nem található.", 404);
  }

  const session = parseSessionFrameRow(result.data as unknown);

  if (session === null) {
    return databaseErrorResponse();
  }

  if (session.status !== ACTIVE_STATUS) {
    return errorResponse("A böngészőnézet már nem aktív.", 409);
  }

  try {
    const browserCommand = await loadBrowserCommand();
    const frame = await browserCommand(session.cdp_url, "frame");
    const frameObject = isRecord(frame) ? frame : { frame };

    return jsonResponse({
      ...frameObject,
      id: session.id,
      control_mode: session.control_mode,
      status: session.status,
    });
  } catch {
    return errorResponse("A képernyő nem érhető el.", 502);
  }
}

async function handleInputPost(context: AuthenticatedRequestContext, body: ParsedInputPostBody): Promise<Response> {
  const staleSequenceResponse = getStaleInputSequenceResponse(context.user.id, body.id, body.sequence);

  if (staleSequenceResponse !== null) {
    return staleSequenceResponse;
  }

  const result = await context.supabase.from("chat_browser_sessions").select("id,cdp_url,control_mode,status").eq("id", body.id).maybeSingle();

  if (result.error) {
    return databaseErrorResponse();
  }

  if (result.data === null) {
    return errorResponse("A böngészőnézet nem található.", 404);
  }

  const session = parseSessionFrameRow(result.data as unknown);

  if (session === null) {
    return databaseErrorResponse();
  }

  if (session.status !== ACTIVE_STATUS) {
    return errorResponse("A böngészőnézet már nem aktív.", 409);
  }

  if (session.control_mode !== "human") {
    return errorResponse("Előbb vedd át az irányítást.", 409);
  }

  let browserCommand: BrowserCommand;

  try {
    browserCommand = await loadBrowserCommand();
  } catch {
    return errorResponse("A bevitel nem érhető el.", 502);
  }

  if (inputNeedsViewportValidation(body.input)) {
    let viewport: ViewportDimensions | null;

    try {
      const frame = await browserCommand(session.cdp_url, "frame");
      viewport = parseViewportDimensions(frame);
    } catch {
      return errorResponse("A képernyő nem érhető el.", 502);
    }

    if (viewport === null) {
      return errorResponse("A képernyő mérete nem állapítható meg.", 502);
    }

    if (!isInputWithinViewport(body.input, viewport)) {
      return errorResponse("A bevitel a képernyőn kívülre esik.", 400);
    }
  }

  const controlConfirmation = await confirmHumanControlForInput(context, body.id);

  if (controlConfirmation !== null) {
    return controlConfirmation;
  }

  try {
    const commandResult = await browserCommand(session.cdp_url, "input", body.input);
    rememberInputSequence(context.user.id, body.id, body.sequence);
    return jsonResponse(commandResult === undefined ? { ok: true } : commandResult);
  } catch {
    return errorResponse("A bevitel sikertelen.", 502);
  }
}

async function confirmHumanControlForInput(context: AuthenticatedRequestContext, id: string): Promise<Response | null> {
  const result = await context.supabase
    .from("chat_browser_sessions")
    .update({ control_mode: "human" })
    .eq("id", id)
    .eq("status", ACTIVE_STATUS)
    .eq("control_mode", "human")
    .select("id")
    .maybeSingle();

  if (result.error) {
    return databaseErrorResponse();
  }

  if (!hasUpdatedIdRow(result.data as unknown)) {
    return errorResponse("Előbb vedd át az irányítást.", 409);
  }

  return null;
}

async function handleModePost(context: AuthenticatedRequestContext, body: ParsedModePostBody): Promise<Response> {
  const result = await context.supabase.from("chat_browser_sessions").select("id,job_id,agent_busy,control_mode,status").eq("id", body.id).maybeSingle();

  if (result.error) {
    return databaseErrorResponse();
  }

  if (result.data === null) {
    return errorResponse("A böngészőnézet nem található.", 404);
  }

  const session = parseControlSessionRow(result.data as unknown);

  if (session === null) {
    return databaseErrorResponse();
  }

  if (session.status !== ACTIVE_STATUS) {
    return errorResponse("A böngésző már leállt.", 409);
  }

  if (body.mode === "human") {
    return await requestHumanControl(context, session);
  }

  return await requestAgentControl(context, session);
}

async function requestHumanControl(context: AuthenticatedRequestContext, session: ControlSessionRow): Promise<Response> {
  if (session.control_mode === "human") {
    return jsonResponse({
      ok: true,
      control_mode: "human",
    });
  }

  if (session.agent_busy) {
    const result = await context.supabase
      .from("chat_browser_sessions")
      .update({ control_mode: "requested" })
      .eq("id", session.id)
      .eq("status", ACTIVE_STATUS)
      .eq("agent_busy", true)
      .neq("control_mode", "human")
      .select("id,control_mode")
      .maybeSingle();

    if (result.error) {
      return databaseErrorResponse();
    }

    const updated = parseControlModeUpdateRow(result.data as unknown);

    if (updated === null) {
      return errorResponse("A böngésző irányítása jelenleg nem vehető át.", 409);
    }

    return jsonResponse(
      {
        ok: false,
        requested: true,
        control_mode: updated.control_mode,
      },
      { status: 202 },
    );
  }

  const result = await context.supabase
    .from("chat_browser_sessions")
    .update({ control_mode: "human" })
    .eq("id", session.id)
    .eq("status", ACTIVE_STATUS)
    .eq("agent_busy", false)
    .neq("control_mode", "human")
    .select("id,control_mode")
    .maybeSingle();

  if (result.error) {
    return databaseErrorResponse();
  }

  const updated = parseControlModeUpdateRow(result.data as unknown);

  if (updated === null) {
    return errorResponse("A böngésző irányítása jelenleg nem vehető át.", 409);
  }

  return jsonResponse({
    ok: true,
    control_mode: updated.control_mode,
  });
}

async function requestAgentControl(context: AuthenticatedRequestContext, session: ControlSessionRow): Promise<Response> {
  if (session.control_mode === "agent") {
    return jsonResponse({
      ok: true,
      control_mode: "agent",
    });
  }

  if (session.control_mode === "human") {
    try {
      const postOperatorMessage = await loadPostOperatorMessage();
      await postOperatorMessage(session.job_id, OPERATOR_HANDOFF_MESSAGE);
    } catch {
      return errorResponse("Az üzenet küldése sikertelen.", 502);
    }

    const result = await context.supabase
      .from("chat_browser_sessions")
      .update({ control_mode: "agent" })
      .eq("id", session.id)
      .eq("status", ACTIVE_STATUS)
      .eq("control_mode", "human")
      .select("id,control_mode")
      .maybeSingle();

    if (result.error) {
      return databaseErrorResponse();
    }

    const updated = parseControlModeUpdateRow(result.data as unknown);

    if (updated === null) {
      return errorResponse("A böngésző irányítása időközben megváltozott.", 409);
    }

    return jsonResponse({
      ok: true,
      control_mode: updated.control_mode,
    });
  }

  const result = await context.supabase
    .from("chat_browser_sessions")
    .update({ control_mode: "agent" })
    .eq("id", session.id)
    .eq("status", ACTIVE_STATUS)
    .eq("control_mode", "requested")
    .select("id,control_mode")
    .maybeSingle();

  if (result.error) {
    return databaseErrorResponse();
  }

  const updated = parseControlModeUpdateRow(result.data as unknown);

  if (updated === null) {
    return errorResponse("A böngésző irányítása időközben megváltozott.", 409);
  }

  return jsonResponse({
    ok: true,
    control_mode: updated.control_mode,
  });
}

async function authenticateRequest(request: Request, requestUrl: URL): Promise<AuthResult> {
  const clientIp = getClientIp(request);
  const unauthenticatedRateLimit = checkRateLimit(`auth:${clientIp}`, 120, 60000);

  if (!unauthenticatedRateLimit.allowed) {
    return {
      ok: false,
      response: rateLimitResponse(unauthenticatedRateLimit.retryAfterSeconds),
    };
  }

  const token = extractAuthToken(request);

  if (token === null) {
    return {
      ok: false,
      response: errorResponse("Bejelentkezés szükséges.", 401),
    };
  }

  const client = createAuthenticatedSupabaseClient(token);

  if (!client.ok) {
    return {
      ok: false,
      response: client.response,
    };
  }

  try {
    const { data: userData, error: userError } = await client.value.auth.getUser(token);

    if (userError || userData.user === null) {
      return {
        ok: false,
        response: errorResponse("Bejelentkezés szükséges.", 401),
      };
    }

    return {
      ok: true,
      context: {
        supabase: client.value,
        user: userData.user,
        token,
        requestUrl,
        clientIp,
      },
    };
  } catch {
    return {
      ok: false,
      response: errorResponse("A hitelesítés átmenetileg nem érhető el.", 502),
    };
  }
}

function createAuthenticatedSupabaseClient(token: string): ParseResult<SupabaseClient> {
  const supabaseUrl = readEnvironmentVariable(["SUPABASE_URL", "VITE_SUPABASE_URL", "PUBLIC_SUPABASE_URL"]);
  const supabaseAnonKey = readEnvironmentVariable(["SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY", "PUBLIC_SUPABASE_ANON_KEY", "PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);

  if (supabaseUrl === null || supabaseAnonKey === null) {
    return {
      ok: false,
      response: errorResponse("A kiszolgáló nincs megfelelően konfigurálva.", 500),
    };
  }

  try {
    new URL(supabaseUrl);
  } catch {
    return {
      ok: false,
      response: errorResponse("A kiszolgáló nincs megfelelően konfigurálva.", 500),
    };
  }

  return {
    ok: true,
    value: createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    }),
  };
}

async function readJsonBody(request: Request): Promise<ParseResult<unknown>> {
  const contentType = request.headers.get("content-type");

  if (!isJsonContentType(contentType)) {
    return {
      ok: false,
      response: errorResponse("A kérés törzsének JSON formátumúnak kell lennie.", 415),
    };
  }

  const contentLengthHeader = request.headers.get("content-length");

  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);

    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return {
        ok: false,
        response: errorResponse("Érvénytelen kérésméret.", 400),
      };
    }

    if (contentLength > MAX_JSON_BODY_BYTES) {
      return {
        ok: false,
        response: errorResponse("A kérés túl nagy.", 413),
      };
    }
  }

  if (request.body === null) {
    return {
      ok: false,
      response: errorResponse("Hiányzó JSON törzs.", 400),
    };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (true) {
      const readResult = await reader.read();

      if (readResult.done) {
        break;
      }

      if (readResult.value !== undefined) {
        totalLength += readResult.value.byteLength;

        if (totalLength > MAX_JSON_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);

          return {
            ok: false,
            response: errorResponse("A kérés túl nagy.", 413),
          };
        }

        chunks.push(readResult.value);
      }
    }
  } catch {
    return {
      ok: false,
      response: errorResponse("A kérés törzse nem olvasható.", 400),
    };
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(bytes);

  if (text.trim().length === 0) {
    return {
      ok: false,
      response: errorResponse("Hiányzó JSON törzs.", 400),
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(text) as unknown,
    };
  } catch {
    return {
      ok: false,
      response: errorResponse("Érvénytelen JSON törzs.", 400),
    };
  }
}

function parsePostRequestBody(value: unknown): ParseResult<ParsedPostBody> {
  if (!isRecord(value)) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen irányítási kérés.", 400),
    };
  }

  const id = value.id;

  if (typeof id !== "string" || !isValidUuid(id)) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen böngészőnézet.", 400),
    };
  }

  const hasInput = hasOwn(value, "input");
  const hasMode = hasOwn(value, "mode");

  if (hasInput && hasMode) {
    return {
      ok: false,
      response: errorResponse("A kérés nem lehet egyszerre bevitel és irányításváltás.", 400),
    };
  }

  if (hasInput) {
    const input = parseBrowserInput(value.input);

    if (!input.ok) {
      return input;
    }

    let sequenceSource: unknown = undefined;

    if (hasOwn(value, "sequence")) {
      sequenceSource = value.sequence;
    } else if (isRecord(value.input) && hasOwn(value.input, "sequence")) {
      sequenceSource = value.input.sequence;
    }

    const sequence = parseOptionalSequence(sequenceSource);

    if (!sequence.ok) {
      return sequence;
    }

    return {
      ok: true,
      value: {
        kind: "input",
        id,
        input: input.value,
        sequence: sequence.value,
      },
    };
  }

  if (hasMode && (value.mode === "human" || value.mode === "agent")) {
    return {
      ok: true,
      value: {
        kind: "mode",
        id,
        mode: value.mode,
      },
    };
  }

  return {
    ok: false,
    response: errorResponse("Érvénytelen irányítási kérés.", 400),
  };
}

function parseBrowserInput(value: unknown): ParseResult<SanitizedBrowserInput> {
  if (!isRecord(value)) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen bevitel.", 400),
    };
  }

  if (value.kind === "mouse") {
    return parseMouseInput(value);
  }

  if (value.kind === "wheel") {
    return parseWheelInput(value);
  }

  if (value.kind === "key") {
    return parseKeyInput(value);
  }

  if (value.kind === "text") {
    return parseTextInput(value);
  }

  return {
    ok: false,
    response: errorResponse("Érvénytelen bevitel.", 400),
  };
}

function parseMouseInput(value: Record<string, unknown>): ParseResult<SanitizedMouseInput> {
  if (value.type !== "mousePressed" && value.type !== "mouseReleased" && value.type !== "mouseMoved") {
    return {
      ok: false,
      response: errorResponse("Érvénytelen egérbevitel.", 400),
    };
  }

  const x = parseCoordinate(value.x);
  const y = parseCoordinate(value.y);

  if (x === null || y === null) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen egérpozíció.", 400),
    };
  }

  const modifiers = parseModifiers(value.modifiers);

  if (modifiers === null) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen módosítóbillentyű.", 400),
    };
  }

  if (value.type === "mousePressed" || value.type === "mouseReleased") {
    if (!isMouseButton(value.button) || value.button === "none") {
      return {
        ok: false,
        response: errorResponse("Érvénytelen egérgomb.", 400),
      };
    }

    const clickCount = parseClickCount(value.clickCount, true);

    if (clickCount === null) {
      return {
        ok: false,
        response: errorResponse("Érvénytelen kattintásszám.", 400),
      };
    }

    return {
      ok: true,
      value: {
        kind: "mouse",
        type: value.type,
        x,
        y,
        button: value.button,
        clickCount,
        modifiers,
      },
    };
  }

  const movedButton = value.button === undefined ? "none" : value.button;

  if (!isMouseButton(movedButton)) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen egérgomb.", 400),
    };
  }

  const clickCount = parseClickCount(value.clickCount, false);

  if (clickCount === null) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen kattintásszám.", 400),
    };
  }

  return {
    ok: true,
    value: {
      kind: "mouse",
      type: "mouseMoved",
      x,
      y,
      button: movedButton,
      clickCount,
      modifiers,
    },
  };
}

function parseWheelInput(value: Record<string, unknown>): ParseResult<SanitizedWheelInput> {
  if (value.type !== "mouseWheel") {
    return {
      ok: false,
      response: errorResponse("Érvénytelen görgetés.", 400),
    };
  }

  const x = parseCoordinate(value.x);
  const y = parseCoordinate(value.y);
  const deltaX = parseWheelDelta(value.deltaX);
  const deltaY = parseWheelDelta(value.deltaY);

  if (x === null || y === null || deltaX === null || deltaY === null) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen görgetés.", 400),
    };
  }

  const modifiers = parseModifiers(value.modifiers);

  if (modifiers === null) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen módosítóbillentyű.", 400),
    };
  }

  return {
    ok: true,
    value: {
      kind: "wheel",
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
      button: "none",
      clickCount: 0,
      modifiers,
    },
  };
}

function parseKeyInput(value: Record<string, unknown>): ParseResult<SanitizedKeyInput> {
  if (value.type !== "keyDown" && value.type !== "keyUp") {
    return {
      ok: false,
      response: errorResponse("Érvénytelen billentyűbevitel.", 400),
    };
  }

  if (typeof value.key !== "string" || value.key.length === 0 || value.key.length > MAX_KEY_STRING_LENGTH) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen billentyű.", 400),
    };
  }

  if (typeof value.code !== "string" || value.code.length === 0 || value.code.length > MAX_KEY_STRING_LENGTH) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen billentyűkód.", 400),
    };
  }

  if (!Number.isInteger(value.keyCode) || typeof value.keyCode !== "number" || value.keyCode < 0 || value.keyCode > 65535) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen billentyűkód.", 400),
    };
  }

  const modifiers = parseModifiers(value.modifiers);

  if (modifiers === null) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen módosítóbillentyű.", 400),
    };
  }

  return {
    ok: true,
    value: {
      kind: "key",
      type: value.type,
      key: value.key,
      code: value.code,
      keyCode: value.keyCode,
      modifiers,
    },
  };
}

function parseTextInput(value: Record<string, unknown>): ParseResult<SanitizedTextInput> {
  if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > MAX_TEXT_INPUT_LENGTH) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen szövegbevitel.", 400),
    };
  }

  return {
    ok: true,
    value: {
      kind: "text",
      text: value.text,
    },
  };
}

function parseOptionalSequence(value: unknown): ParseResult<number | null> {
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: null,
    };
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen sorszám.", 400),
    };
  }

  return {
    ok: true,
    value,
  };
}

function parsePagination(params: URLSearchParams): ParseResult<Pagination> {
  const limit = parseIntegerSearchParam(params.get("limit"), 50, 1, 100);

  if (!limit.ok) {
    return limit;
  }

  const offset = parseIntegerSearchParam(params.get("offset"), 0, 0, 1000000);

  if (!offset.ok) {
    return offset;
  }

  return {
    ok: true,
    value: {
      limit: limit.value,
      offset: offset.value,
    },
  };
}

function parseIntegerSearchParam(value: string | null, defaultValue: number, minimum: number, maximum: number): ParseResult<number> {
  if (value === null) {
    return {
      ok: true,
      value: defaultValue,
    };
  }

  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen lapozás.", 400),
    };
  }

  const parsed = Number(trimmed);

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return {
      ok: false,
      response: errorResponse("Érvénytelen lapozás.", 400),
    };
  }

  return {
    ok: true,
    value: parsed,
  };
}

function parseCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  if (value < 0 || value > MAX_COORDINATE_BEFORE_VIEWPORT_CHECK) {
    return null;
  }

  return value;
}

function parseWheelDelta(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  if (Math.abs(value) > MAX_WHEEL_DELTA) {
    return null;
  }

  return value;
}

function parseModifiers(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 15) {
    return null;
  }

  return value;
}

function parseClickCount(value: unknown, required: boolean): number | null {
  if (value === undefined || value === null) {
    return required ? null : 0;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }

  if (required) {
    return value >= 1 && value <= 3 ? value : null;
  }

  return value >= 0 && value <= 3 ? value : null;
}

function parseSessionListRows(value: unknown): SessionListItem[] | null {
  if (value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const rows: unknown[] = value;
  const sessions: SessionListItem[] = [];

  for (const row of rows) {
    const parsed = parseSessionListRow(row);

    if (parsed === null) {
      return null;
    }

    sessions.push(parsed);
  }

  return sessions;
}

function parseSessionListRow(value: unknown): SessionListItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const controlMode = value.control_mode;
  const status = value.status;
  const createdAt = value.created_at;

  if (typeof id !== "string" || !isValidUuid(id) || !isControlMode(controlMode) || typeof status !== "string" || status.length === 0) {
    return null;
  }

  if (createdAt !== null && typeof createdAt !== "string") {
    return null;
  }

  return {
    id,
    control_mode: controlMode,
    status,
    created_at: createdAt,
  };
}

function parseSessionMetadataRow(value: unknown): SessionMetadataRow | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const controlMode = value.control_mode;
  const status = value.status;

  if (typeof id !== "string" || !isValidUuid(id) || !isControlMode(controlMode) || typeof status !== "string" || status.length === 0) {
    return null;
  }

  return {
    id,
    control_mode: controlMode,
    status,
  };
}

function parseSessionFrameRow(value: unknown): SessionFrameRow | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const cdpUrl = value.cdp_url;
  const controlMode = value.control_mode;
  const status = value.status;

  if (typeof id !== "string" || !isValidUuid(id) || typeof cdpUrl !== "string" || cdpUrl.length === 0 || !isControlMode(controlMode) || typeof status !== "string" || status.length === 0) {
    return null;
  }

  return {
    id,
    cdp_url: cdpUrl,
    control_mode: controlMode,
    status,
  };
}

function parseControlSessionRow(value: unknown): ControlSessionRow | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const jobId = value.job_id;
  const agentBusy = value.agent_busy;
  const controlMode = value.control_mode;
  const status = value.status;

  if (typeof id !== "string" || !isValidUuid(id) || typeof jobId !== "string" || !isValidUuid(jobId) || typeof agentBusy !== "boolean" || !isControlMode(controlMode) || typeof status !== "string" || status.length === 0) {
    return null;
  }

  return {
    id,
    job_id: jobId,
    agent_busy: agentBusy,
    control_mode: controlMode,
    status,
  };
}

function parseControlModeUpdateRow(value: unknown): ControlModeUpdateRow | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const controlMode = value.control_mode;

  if (typeof id !== "string" || !isValidUuid(id) || !isControlMode(controlMode)) {
    return null;
  }

  return {
    id,
    control_mode: controlMode,
  };
}

function parseViewportDimensions(value: unknown): ViewportDimensions | null {
  const direct = parseViewportDimensionsFromRecord(value);

  if (direct !== null) {
    return direct;
  }

  if (!isRecord(value)) {
    return null;
  }

  const nestedKeys = ["viewport", "screen", "layoutViewport", "visualViewport", "contentSize", "metadata"];

  for (const key of nestedKeys) {
    const nested = parseViewportDimensionsFromRecord(value[key]);

    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function parseViewportDimensionsFromRecord(value: unknown): ViewportDimensions | null {
  if (!isRecord(value)) {
    return null;
  }

  const width = firstValidDimension(value, ["width", "viewportWidth", "clientWidth", "innerWidth", "screenWidth"]);
  const height = firstValidDimension(value, ["height", "viewportHeight", "clientHeight", "innerHeight", "screenHeight"]);

  if (width === null || height === null) {
    return null;
  }

  return {
    width,
    height,
  };
}

function firstValidDimension(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const dimension = parseDimension(record[key]);

    if (dimension !== null) {
      return dimension;
    }
  }

  return null;
}

function parseDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const integer = Math.floor(value);

  if (integer <= 0 || integer > MAX_VIEWPORT_DIMENSION) {
    return null;
  }

  return integer;
}

function inputNeedsViewportValidation(input: SanitizedBrowserInput): input is SanitizedMouseInput | SanitizedWheelInput {
  return input.kind === "mouse" || input.kind === "wheel";
}

function isInputWithinViewport(input: SanitizedMouseInput | SanitizedWheelInput, viewport: ViewportDimensions): boolean {
  return input.x >= 0 && input.x < viewport.width && input.y >= 0 && input.y < viewport.height;
}

function getStaleInputSequenceResponse(userId: string, sessionId: string, sequence: number | null): Response | null {
  if (sequence === null) {
    return null;
  }

  const state = getBrowserApiRouteState();
  const key = `${userId}:${sessionId}`;
  const current = state.inputSequences.get(key);

  if (current !== undefined && sequence <= current.sequence) {
    return errorResponse("Elavult bevitel.", 409);
  }

  return null;
}

function rememberInputSequence(userId: string, sessionId: string, sequence: number | null): void {
  if (sequence === null) {
    return;
  }

  const state = getBrowserApiRouteState();
  state.inputSequences.set(`${userId}:${sessionId}`, {
    sequence,
    updatedAt: Date.now(),
  });
}

function validatePostOrigin(request: Request, requestUrl: URL): Response | null {
  const allowedOrigins = getAllowedOrigins(requestUrl);
  const originHeader = request.headers.get("origin");

  if (originHeader !== null && originHeader.trim().length > 0) {
    const origin = normalizeOrigin(originHeader);

    if (origin !== null && allowedOrigins.has(origin)) {
      return null;
    }

    return errorResponse("A kérés forrása nem engedélyezett.", 403);
  }

  const refererHeader = request.headers.get("referer");

  if (refererHeader !== null && refererHeader.trim().length > 0) {
    const refererOrigin = normalizeOrigin(refererHeader);

    if (refererOrigin !== null && allowedOrigins.has(refererOrigin)) {
      return null;
    }

    return errorResponse("A kérés forrása nem engedélyezett.", 403);
  }

  return errorResponse("A kérés forrása nem ellenőrizhető.", 403);
}

function getAllowedOrigins(requestUrl: URL): Set<string> {
  const allowedOrigins = new Set<string>([requestUrl.origin]);
  const configured = readEnvironmentVariable(["BROWSER_API_ALLOWED_ORIGINS", "ALLOWED_ORIGINS"]);

  if (configured !== null) {
    for (const originValue of configured.split(",")) {
      const origin = normalizeOrigin(originValue.trim());

      if (origin !== null) {
        allowedOrigins.add(origin);
      }
    }
  }

  return allowedOrigins;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function extractAuthToken(request: Request): string | null {
  const bearerToken = extractBearerToken(request);

  if (bearerToken !== null) {
    return bearerToken;
  }

  return extractSupabaseAccessTokenFromCookies(request.headers.get("cookie"));
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");

  if (authorization === null) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());

  if (match === null) {
    return null;
  }

  const token = match[1];

  if (typeof token !== "string" || token.trim().length === 0) {
    return null;
  }

  return token.trim();
}

function extractSupabaseAccessTokenFromCookies(cookieHeader: string | null): string | null {
  const cookies = parseCookieHeader(cookieHeader);
  const candidates = getAuthCookieCandidates(cookies);

  for (const candidate of candidates) {
    const token = extractAccessTokenFromCookieValue(candidate);

    if (token !== null) {
      return token;
    }
  }

  return null;
}

function parseCookieHeader(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();

  if (cookieHeader === null || cookieHeader.trim().length === 0) {
    return cookies;
  }

  for (const cookiePart of cookieHeader.split(";")) {
    const separatorIndex = cookiePart.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const name = cookiePart.slice(0, separatorIndex).trim();
    const value = cookiePart.slice(separatorIndex + 1).trim();

    if (name.length > 0) {
      cookies.set(name, value);
    }
  }

  return cookies;
}

function getAuthCookieCandidates(cookies: Map<string, string>): string[] {
  const candidates: string[] = [];
  const chunks = new Map<string, Array<{ index: number; value: string }>>();

  for (const [name, value] of cookies) {
    const chunkMatch = /^(.*)\.(\d+)$/.exec(name);

    if (chunkMatch !== null) {
      const baseName = chunkMatch[1];
      const indexText = chunkMatch[2];

      if (typeof baseName === "string" && typeof indexText === "string" && isAuthCookieName(baseName)) {
        const index = Number(indexText);

        if (Number.isSafeInteger(index) && index >= 0) {
          const existing = chunks.get(baseName) ?? [];
          existing.push({ index, value });
          chunks.set(baseName, existing);
        }
      }

      continue;
    }

    if (isAuthCookieName(name)) {
      candidates.push(value);
    }
  }

  for (const chunkValues of chunks.values()) {
    const ordered = [...chunkValues].sort((left, right) => left.index - right.index);
    candidates.push(ordered.map((chunk) => chunk.value).join(""));
  }

  return candidates;
}

function isAuthCookieName(name: string): boolean {
  return name === "supabase-auth-token" || name.endsWith("-auth-token") || name.includes("auth-token");
}

function extractAccessTokenFromCookieValue(value: string): string | null {
  const decoded = decodeCookieComponent(value);
  const valuesToTry: string[] = [decoded];

  if (decoded.startsWith("base64-")) {
    const base64Decoded = decodeBase64String(decoded.slice("base64-".length));

    if (base64Decoded !== null) {
      valuesToTry.push(base64Decoded);
    }
  }

  for (const possibleValue of valuesToTry) {
    const trimmed = possibleValue.trim();

    if (looksLikeJwt(trimmed)) {
      return trimmed;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const token = extractAccessTokenFromParsedCookie(parsed);

      if (token !== null) {
        return token;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function extractAccessTokenFromParsedCookie(value: unknown): string | null {
  if (typeof value === "string" && looksLikeJwt(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const values: unknown[] = value;

    for (const item of values) {
      const token = extractAccessTokenFromParsedCookie(item);

      if (token !== null) {
        return token;
      }
    }

    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const accessToken = value.access_token;

  if (typeof accessToken === "string" && looksLikeJwt(accessToken)) {
    return accessToken;
  }

  const currentSessionToken = extractAccessTokenFromParsedCookie(value.currentSession);

  if (currentSessionToken !== null) {
    return currentSessionToken;
  }

  return extractAccessTokenFromParsedCookie(value.session);
}

function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function decodeCookieComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeBase64String(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (normalized.length % 4)) % 4;
    return atob(normalized + "=".repeat(paddingLength));
  } catch {
    return null;
  }
}

function getRequestUrl(request: Request): URL {
  const forwardedProtocol = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : "https";
  const host = firstHeaderValue(request.headers.get("x-forwarded-host")) ?? firstHeaderValue(request.headers.get("host")) ?? "localhost";
  const base = `${protocol}://${host}`;

  try {
    return new URL(request.url, base);
  } catch {
    try {
      return new URL(base);
    } catch {
      return new URL("https://localhost");
    }
  }
}

function getClientIp(request: Request): string {
  return firstHeaderValue(request.headers.get("x-forwarded-for")) ?? firstHeaderValue(request.headers.get("cf-connecting-ip")) ?? firstHeaderValue(request.headers.get("x-real-ip")) ?? "unknown";
}

function firstHeaderValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const first = value.split(",")[0]?.trim();

  return first && first.length > 0 ? first : null;
}

function readEnvironmentVariable(names: readonly string[]): string | null {
  const globalProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;

  for (const name of names) {
    const value = globalProcess?.env?.[name];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };

  for (const name of names) {
    const value = meta.env?.[name];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function checkRateLimit(key: string, limit: number, windowMs: number): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const state = getBrowserApiRouteState();
  const now = Date.now();
  pruneBrowserApiRouteState(state, now);
  const existing = state.rateLimits.get(key);

  if (existing === undefined || existing.resetAt <= now) {
    state.rateLimits.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });

    return {
      allowed: true,
    };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;

  return {
    allowed: true,
  };
}

function pruneBrowserApiRouteState(state: BrowserApiRouteState, now: number): void {
  if (now - state.lastPrunedAt < 60000) {
    return;
  }

  state.lastPrunedAt = now;

  for (const [key, entry] of state.rateLimits) {
    if (entry.resetAt <= now) {
      state.rateLimits.delete(key);
    }
  }

  for (const [key, entry] of state.inputSequences) {
    if (entry.updatedAt + INPUT_SEQUENCE_TTL_MS <= now) {
      state.inputSequences.delete(key);
    }
  }
}

function getBrowserApiRouteState(): BrowserApiRouteState {
  const globalObject = globalThis as typeof globalThis & { __browserApiRouteState?: BrowserApiRouteState };

  if (globalObject.__browserApiRouteState === undefined) {
    globalObject.__browserApiRouteState = {
      rateLimits: new Map<string, RateLimitEntry>(),
      queues: new Map<string, Promise<void>>(),
      inputSequences: new Map<string, InputSequenceEntry>(),
      lastPrunedAt: Date.now(),
    };
  }

  return globalObject.__browserApiRouteState;
}

async function withSessionQueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const state = getBrowserApiRouteState();
  const key = `session:${sessionId}`;
  const previous = state.queues.get(key) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  state.queues.set(key, queued);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent();

    if (state.queues.get(key) === queued) {
      state.queues.delete(key);
    }
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  const mediaType = value.split(";")[0]?.trim().toLowerCase();

  return mediaType === "application/json" || (mediaType !== undefined && mediaType.endsWith("+json"));
}

function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isControlMode(value: unknown): value is ControlMode {
  return value === "agent" || value === "human" || value === "requested";
}

function isMouseButton(value: unknown): value is MouseButton {
  return typeof value === "string" && MOUSE_BUTTON_VALUES.includes(value as MouseButton);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUpdatedIdRow(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && isValidUuid(value.id);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body === undefined ? null : body, {
    ...init,
    headers,
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse(
    {
      error: message,
    },
    {
      status,
    },
  );
}

function databaseErrorResponse(): Response {
  return errorResponse("Adatbázis-hiba történt.", 500);
}

function rateLimitResponse(retryAfterSeconds: number): Response {
  return jsonResponse(
    {
      error: "Túl sok kérés.",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

async function loadBrowserCommand(): Promise<BrowserCommand> {
  const module = await import("@/lib/browser-cdp.server");
  return module.browserCommand as BrowserCommand;
}

async function loadPostOperatorMessage(): Promise<PostOperatorMessage> {
  const module = await import("@/lib/cognitive.server");
  return module.postOperatorMessage as PostOperatorMessage;
}
