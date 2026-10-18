import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type ControlMode = "agent" | "requested" | "human";
type SessionStatus = string;

type MouseButton = "none" | "left" | "middle" | "right" | "back" | "forward";

type MouseInput = {
  kind: "mouse";
  type: "mousePressed" | "mouseReleased" | "mouseMoved";
  x: number;
  y: number;
  button: MouseButton;
  clickCount: number;
  modifiers: number;
};

type WheelInput = {
  kind: "wheel";
  type: "mouseWheel";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers: number;
};

type KeyInput = {
  kind: "key";
  type: "keyDown" | "keyUp";
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
};

type TextInput = {
  kind: "text";
  text: string;
};

type BrowserInput = MouseInput | WheelInput | KeyInput | TextInput;

type InputRequest = { id: string; seq: number; input: BrowserInput };
type ModeRequest = { id: string; mode: "human" | "agent" };

type SessionRow = {
  id: string;
  cdp_url: string;
  control_mode: ControlMode;
  status: SessionStatus;
  viewport_width: number;
  viewport_height: number;
};

type ModeRow = {
  id: string;
  job_id: string;
  control_mode: ControlMode;
};

type SessionListRow = {
  id: string;
  control_mode: ControlMode;
  status: SessionStatus;
  created_at: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;
const MAX_BODY_BYTES = 16384;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 1029;
const MAX_WHEEL_DELTA = 10000;
const MAX_KEY_CODE = 255;
const MAX_MODIFIERS = 15;
const MAX_CLICK_COUNT = 3;
const MAX_TEXT_LENGTH = 10000;
const MAX_KEY_LENGTH = 40;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 100000;
const MOUSE_TYPES: ReadonlyArray<MouseInput["type"]> = ["mousePressed", "mouseReleased", "mouseMoved"];
const MOUSE_BUTTONS: ReadonlyArray<MouseButton> = ["none", "left", "middle", "right", "back", "forward"];
const KEY_TYPES: ReadonlyArray<KeyInput["type"]> = ["keyDown", "keyUp"];
const CONTROL_MODES: ReadonlyArray<ControlMode> = ["agent", "requested", "human"];
const AGENT_RESUME_MESSAGE = "A felhasználó visszaadta a böngésző irányítását. Vizsgáld meg az aktuális oldalt, és onnan folytasd; ne ismételd meg a már elvégzett műveleteket.";

const RATE_LIMITS = {
  list: { limit: 60, windowMs: 60000 },
  status: { limit: 120, windowMs: 60000 },
  frame: { limit: 180, windowMs: 60000 },
  input: { limit: 1200, windowMs: 60000 },
  mode: { limit: 20, windowMs: 60000 },
} as const;

type RateLimitName = keyof typeof RATE_LIMITS;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const sessionQueues = new Map<string, Promise<void>>();
const lastSequences = new Map<string, number>();

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extraHeaders } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isControlMode(value: unknown): value is ControlMode {
  return typeof value === "string" && (CONTROL_MODES as ReadonlyArray<string>).includes(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isCoordinate(value: unknown, size: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < size;
}

function isPositiveDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10000;
}

function logError(context: string, error: unknown): void {
  console.error(`[api/browser] ${context}`, error instanceof Error ? error.name : "UnknownError");
}

function checkRateLimit(name: RateLimitName, key: string): Response | null {
  const { limit, windowMs } = RATE_LIMITS[name];
  const bucketKey = `${name}:${key}`;
  const now = Date.now();
  const bucket = rateBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    if (rateBuckets.size > 50000) {
      for (const [storedKey, storedBucket] of rateBuckets) {
        if (storedBucket.resetAt <= now) rateBuckets.delete(storedKey);
      }
    }
    return null;
  }
  if (bucket.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return json({ error: "Túl sok kérés. Próbáld újra később." }, 429, { "Retry-After": String(retryAfter) });
  }
  bucket.count += 1;
  return null;
}

function parseRequestUrl(request: Request): URL | null {
  try {
    return new URL(request.url, "http://localhost");
  } catch {
    return null;
  }
}

function getAllowedOrigins(request: Request): Set<string> {
  const allowed = new Set<string>();
  const configured = process.env.APP_ORIGINS ?? process.env.APP_ORIGIN ?? "";
  for (const entry of configured.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      allowed.add(new URL(trimmed).origin);
    } catch {
      continue;
    }
  }
  try {
    const self = new URL(request.url);
    allowed.add(self.origin);
  } catch {
    const host = request.headers.get("host");
    if (host) {
      const protocol = request.headers.get("x-forwarded-proto") === "http" ? "http" : "https";
      allowed.add(`${protocol}://${host}`);
    }
  }
  return allowed;
}

function verifyOrigin(request: Request): Response | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return json({ error: "Érvénytelen kérés eredete." }, 403);
  }
  const allowed = getAllowedOrigins(request);
  const origin = request.headers.get("origin");
  if (origin) {
    return allowed.has(origin) ? null : json({ error: "Érvénytelen kérés eredete." }, 403);
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin) ? null : json({ error: "Érvénytelen kérés eredete." }, 403);
    } catch {
      return json({ error: "Érvénytelen kérés eredete." }, 403);
    }
  }
  return json({ error: "Érvénytelen kérés eredete." }, 403);
}

async function readJsonBody(request: Request): Promise<Result<unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: json({ error: "A kérés tartalma JSON kell legyen." }, 415) };
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > MAX_BODY_BYTES) {
      return { ok: false, response: json({ error: "A kérés túl nagy." }, 413) };
    }
  }
  if (!request.body) {
    return { ok: false, response: json({ error: "Hiányzó kéréstartalom." }, 400) };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: json({ error: "A kérés túl nagy." }, 413) };
      }
      chunks.push(value);
    }
  } catch (error) {
    logError("body read failed", error);
    return { ok: false, response: json({ error: "A kérés nem olvasható." }, 400) };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, response: json({ error: "Érvénytelen JSON." }, 400) };
  }
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9\-_.]+)$/.exec(header.trim());
  return match ? match[1] : null;
}

async function authenticate(request: Request): Promise<Result<{ userId: string; client: SupabaseClient }>> {
  const token = getBearerToken(request);
  if (!token) return { ok: false, response: json({ error: "Bejelentkezés szükséges." }, 401) };
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    logError("missing supabase configuration", new Error("config"));
    return { ok: false, response: json({ error: "Belső szerverhiba." }, 500) };
  }
  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return { ok: false, response: json({ error: "Bejelentkezés szükséges." }, 401) };
  return { ok: true, value: { userId: data.user.id, client } };
}

async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function verifySessionAccess(client: SupabaseClient, id: string): Promise<Response | null> {
  const { data, error } = await client.from("chat_browser_sessions").select("id").eq("id", id).maybeSingle();
  if (error) {
    logError("session access check failed", error);
    return json({ error: "Belső szerverhiba." }, 500);
  }
  if (!data) return json({ error: "A böngészőnézet nem található." }, 404);
  return null;
}

async function verifyConversationAccess(client: SupabaseClient, conversation: string): Promise<Response | null> {
  const { data, error } = await client.from("chat_jobs").select("id").eq("conversation_id", conversation).limit(1);
  if (error) {
    logError("conversation access check failed", error);
    return json({ error: "Belső szerverhiba." }, 500);
  }
  if (!data || data.length === 0) return json({ sessions: [], nextOffset: null }, 200);
  return null;
}

function parseSessionRow(value: unknown): SessionRow | null {
  if (!isRecord(value)) return null;
  const { id, cdp_url, control_mode, status, viewport_width, viewport_height } = value;
  if (typeof id !== "string" || typeof cdp_url !== "string" || !isControlMode(control_mode) || typeof status !== "string") return null;
  return {
    id,
    cdp_url,
    control_mode,
    status,
    viewport_width: isPositiveDimension(viewport_width) ? viewport_width : DEFAULT_VIEWPORT_WIDTH,
    viewport_height: isPositiveDimension(viewport_height) ? viewport_height : DEFAULT_VIEWPORT_HEIGHT,
  };
}

function parseModeRow(value: unknown): ModeRow | null {
  if (!isRecord(value)) return null;
  const { id, job_id, control_mode } = value;
  if (typeof id !== "string" || typeof job_id !== "string" || !isControlMode(control_mode)) return null;
  return { id, job_id, control_mode };
}

function parseSessionList(value: unknown): SessionListRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SessionListRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { id, control_mode, status, created_at } = item;
    if (typeof id === "string" && isControlMode(control_mode) && typeof status === "string" && typeof created_at === "string") {
      rows.push({ id, control_mode, status, created_at });
    }
  }
  return rows;
}

function parseBoundedInteger(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function validateInputShape(value: unknown): BrowserInput | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind === "mouse") {
    const { type, x, y, button, clickCount, modifiers } = value;
    if (typeof type !== "string" || !(MOUSE_TYPES as ReadonlyArray<string>).includes(type)) return null;
    if (typeof button !== "string" || !(MOUSE_BUTTONS as ReadonlyArray<string>).includes(button)) return null;
    if (!isIntegerInRange(clickCount, 0, MAX_CLICK_COUNT)) return null;
    if (!isIntegerInRange(modifiers, 0, MAX_MODIFIERS)) return null;
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return null;
    const mouseType = type as MouseInput["type"];
    const mouseButton = button as MouseButton;
    if (mouseType !== "mouseMoved" && (mouseButton === "none" || clickCount < 1)) return null;
    return { kind: "mouse", type: mouseType, x, y, button: mouseButton, clickCount, modifiers };
  }
  if (kind === "wheel") {
    const { type, x, y, deltaX, deltaY, modifiers } = value;
    if (type !== "mouseWheel") return null;
    if (!isFiniteInRange(deltaX, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA) || !isFiniteInRange(deltaY, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA)) return null;
    if (!isIntegerInRange(modifiers, 0, MAX_MODIFIERS)) return null;
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return null;
    return { kind: "wheel", type: "mouseWheel", x, y, deltaX, deltaY, modifiers };
  }
  if (kind === "key") {
    const { type, key, code, keyCode, modifiers } = value;
    if (typeof type !== "string" || !(KEY_TYPES as ReadonlyArray<string>).includes(type)) return null;
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
    if (typeof code !== "string" || code.length === 0 || code.length > MAX_KEY_LENGTH) return null;
    if (!isIntegerInRange(keyCode, 0, MAX_KEY_CODE)) return null;
    if (!isIntegerInRange(modifiers, 0, MAX_MODIFIERS)) return null;
    return { kind: "key", type: type as KeyInput["type"], key, code, keyCode, modifiers };
  }
  if (kind === "text") {
    const { text } = value;
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) return null;
    return { kind: "text", text };
  }
  return null;
}

function inputWithinViewport(input: BrowserInput, width: number, height: number): boolean {
  if (input.kind === "mouse" || input.kind === "wheel") {
    return isCoordinate(input.x, width) && isCoordinate(input.y, height);
  }
  return true;
}

function parseInputRequest(body: Record<string, unknown>): InputRequest | null {
  if (!isUuid(body.id)) return null;
  if (!isIntegerInRange(body.seq, 0, Number.MAX_SAFE_INTEGER)) return null;
  const input = validateInputShape(body.input);
  if (!input) return null;
  return { id: body.id, seq: body.seq, input };
}

function parseModeRequest(body: Record<string, unknown>): ModeRequest | null {
  if (!isUuid(body.id)) return null;
  if (body.mode !== "human" && body.mode !== "agent") return null;
  return { id: body.id, mode: body.mode };
}

async function runSerialized<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  sessionQueues.set(sessionId, chained);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (sessionQueues.get(sessionId) === chained) sessionQueues.delete(sessionId);
  }
}

function toPayload(result: unknown): Record<string, unknown> {
  if (isRecord(result)) return result;
  return { result: result === undefined ? null : result };
}

async function handleConversationList(client: SupabaseClient, url: URL, conversation: string, userId: string): Promise<Response> {
  const limited = checkRateLimit("list", userId);
  if (limited) return limited;
  const pageSize = parseBoundedInteger(url.searchParams.get("limit"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, MAX_OFFSET);
  if (pageSize === null || offset === null) return json({ error: "Érvénytelen lapozási paraméter." }, 400);
  const denied = await verifyConversationAccess(client, conversation);
  if (denied) return denied;
  const supabaseAdmin = await getAdmin();
  const { data, error } = await supabaseAdmin
    .from("chat_browser_sessions")
    .select("id,control_mode,status,created_at,chat_jobs!inner(conversation_id)")
    .eq("chat_jobs.conversation_id", conversation)
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize);
  if (error) {
    logError("session list query failed", error);
    return json({ error: "Belső szerverhiba." }, 500);
  }
  const rows = parseSessionList(data as unknown);
  const hasMore = rows.length > pageSize;
  const sessions = hasMore ? rows.slice(0, pageSize) : rows;
  return json({ sessions, nextOffset: hasMore ? offset + pageSize : null });
}

async function loadSession(id: string): Promise<Result<SessionRow>> {
  const supabaseAdmin = await getAdmin();
  const { data, error } = await supabaseAdmin
    .from("chat_browser_sessions")
    .select("id,cdp_url,control_mode,status,viewport_width,viewport_height")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logError("session lookup failed", error);
    return { ok: false, response: json({ error: "Belső szerverhiba." }, 500) };
  }
  if (!data) return { ok: false, response: json({ error: "A böngészőnézet nem található." }, 404) };
  const row = parseSessionRow(data as unknown);
  if (!row) {
    logError("session row malformed", new Error("malformed"));
    return { ok: false, response: json({ error: "Belső szerverhiba." }, 500) };
  }
  return { ok: true, value: row };
}

async function handleSessionStatus(client: SupabaseClient, url: URL, id: string, userId: string): Promise<Response> {
  const wantsFrame = url.searchParams.has("frame");
  const limited = checkRateLimit(wantsFrame ? "frame" : "status", `${userId}:${id}`);
  if (limited) return limited;
  const denied = await verifySessionAccess(client, id);
  if (denied) return denied;
  const loaded = await loadSession(id);
  if (!loaded.ok) return loaded.response;
  const session = loaded.value;
  if (!wantsFrame) return json({ id: session.id, control_mode: session.control_mode, status: session.status });
  if (session.status !== "active") {
    return json({ id: session.id, error: "A böngésző már leállt.", control_mode: session.control_mode, status: session.status }, 409);
  }
  try {
    const { browserCommand } = await import("@/lib/browser-cdp.server");
    const frame: unknown = await browserCommand(session.cdp_url, "frame");
    return json({ ...toPayload(frame), id: session.id, control_mode: session.control_mode, status: session.status });
  } catch (error) {
    logError("frame capture failed", error);
    return json({ id: session.id, error: "A képernyő nem érhető el." }, 502);
  }
}

async function handleInput(client: SupabaseClient, userId: string, request: InputRequest): Promise<Response> {
  const limited = checkRateLimit("input", `${userId}:${request.id}`);
  if (limited) return limited;
  const denied = await verifySessionAccess(client, request.id);
  if (denied) return denied;
  return runSerialized(request.id, async () => {
    const lastSeq = lastSequences.get(request.id);
    if (lastSeq !== undefined && request.seq <= lastSeq) {
      return json({ error: "Elavult vagy ismételt bevitel.", lastSeq }, 409);
    }
    const loaded = await loadSession(request.id);
    if (!loaded.ok) return loaded.response;
    const session = loaded.value;
    if (session.status !== "active") return json({ error: "A böngésző már leállt." }, 409);
    if (session.control_mode !== "human") return json({ error: "Előbb vedd át az irányítást." }, 409);
    if (!inputWithinViewport(request.input, session.viewport_width, session.viewport_height)) {
      return json({ error: "Érvénytelen bevitel." }, 400);
    }
    lastSequences.set(request.id, request.seq);
    if (lastSequences.size > 10000) {
      const oldest = lastSequences.keys().next();
      if (!oldest.done && oldest.value !== request.id) lastSequences.delete(oldest.value);
    }
    try {
      const { browserCommand } = await import("@/lib/browser-cdp.server");
      const result: unknown = await browserCommand(session.cdp_url, "input", request.input);
      return json({ ok: true, seq: request.seq, result: result === undefined ? null : result });
    } catch (error) {
      logError("input dispatch failed", error);
      return json({ error: "A bevitel sikertelen." }, 502);
    }
  });
}

async function handleTakeover(id: string): Promise<Response> {
  const supabaseAdmin = await getAdmin();
  const granted = await supabaseAdmin
    .from("chat_browser_sessions")
    .update({ control_mode: "human" })
    .eq("id", id)
    .eq("status", "active")
    .eq("agent_busy", false)
    .in("control_mode", ["agent", "requested"])
    .select("id")
    .maybeSingle();
  if (granted.error) {
    logError("takeover grant failed", granted.error);
    return json({ error: "Belső szerverhiba." }, 500);
  }
  if (granted.data) return json({ ok: true, id, control_mode: "human" });
  const requested = await supabaseAdmin
    .from("chat_browser_sessions")
    .update({ control_mode: "requested" })
    .eq("id", id)
    .eq("status", "active")
    .eq("control_mode", "agent")
    .select("id")
    .maybeSingle();
  if (requested.error) {
    logError("takeover request failed", requested.error);
    return json({ error: "Belső szerverhiba." }, 500);
  }
  if (requested.data) return json({ ok: true, id, control_mode: "requested" }, 202);
  const loaded = await loadSession(id);
  if (!loaded.ok) return loaded.response;
  const session = loaded.value;
  if (session.status !== "active") return json({ error: "A böngésző már leállt." }, 409);
  if (session.control_mode === "human") return json({ ok: true, id, control_mode: "human" });
  if (session.control_mode === "requested") return json({ ok: true, id, control_mode: "requested" }, 202);
  return json({ error: "Az irányítás átvétele nem sikerült. Próbáld újra." }, 409);
}

async function handleHandback(id: string): Promise<Response> {
  const supabaseAdmin = await getAdmin();
  const updated = await supabaseAdmin
    .from("chat_browser_sessions")
    .update({ control_mode: "agent" })
    .eq("id", id)
    .eq("status", "active")
    .in("control_mode", ["human", "requested"])
    .select("id,job_id,control_mode")
    .maybeSingle();
  if (updated.error) {
    logError("handback update failed", updated.error);
    return json({ error: "Belső szerverhiba." }, 500);
  }
  if (!updated.data) {
    const loaded = await loadSession(id);
    if (!loaded.ok) return loaded.response;
    const session = loaded.value;
    if (session.status !== "active") return json({ error: "A böngésző már leállt." }, 409);
    if (session.control_mode === "agent") return json({ ok: true, id, control_mode: "agent" });
    return json({ error: "Az irányítás visszaadása nem sikerült. Próbáld újra." }, 409);
  }
  const row = parseModeRow(updated.data as unknown);
  if (!row) {
    logError("handback row malformed", new Error("malformed"));
    return json({ error: "Belső szerverhiba." }, 500);
  }
  try {
    const { postOperatorMessage } = await import("@/lib/cognitive.server");
    await postOperatorMessage(row.job_id, AGENT_RESUME_MESSAGE);
  } catch (error) {
    logError("operator message failed", error);
    const reverted = await supabaseAdmin
      .from("chat_browser_sessions")
      .update({ control_mode: "human" })
      .eq("id", id)
      .eq("status", "active")
      .eq("control_mode", "agent")
      .select("id")
      .maybeSingle();
    if (reverted.error) logError("handback revert failed", reverted.error);
    return json({ error: "Az ügynök értesítése sikertelen; az irányítás nálad maradt." }, 502);
  }
  return json({ ok: true, id, control_mode: "agent" });
}

export const Route = createFileRoute("/api/browser")({
  server: {
    handlers: {
  GET: async ({ request }: { request: Request }) => {
    try {
      const url = parseRequestUrl(request);
      if (!url) return json({ error: "Érvénytelen kérés." }, 400);
      const auth = await authenticate(request);
      if (!auth.ok) return auth.response;
      const { client, userId } = auth.value;
      if (url.searchParams.has("conversation")) {
        const conversation = url.searchParams.get("conversation");
        if (!isUuid(conversation)) return json({ error: "Érvénytelen beszélgetés." }, 400);
        return await handleConversationList(client, url, conversation, userId);
      }
      const id = url.searchParams.get("id");
      if (!isUuid(id)) return json({ error: "Érvénytelen böngészőnézet." }, 400);
      return await handleSessionStatus(client, url, id, userId);
    } catch (unexpected) {
      logError("GET failed", unexpected);
      return json({ error: "Belső szerverhiba." }, 500);
    }
  },
  POST: async ({ request }: { request: Request }) => {
    try {
      const originDenied = verifyOrigin(request);
      if (originDenied) return originDenied;
      const auth = await authenticate(request);
      if (!auth.ok) return auth.response;
      const { client, userId } = auth.value;
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      if (!isRecord(body)) return json({ error: "Érvénytelen kérés." }, 400);
      if ("input" in body) {
        const inputRequest = parseInputRequest(body);
        if (!inputRequest) return json({ error: "Érvénytelen bevitel." }, 400);
        return await handleInput(client, userId, inputRequest);
      }
      const modeRequest = parseModeRequest(body);
      if (!modeRequest) return json({ error: "Érvénytelen irányítási kérés." }, 400);
      const limited = checkRateLimit("mode", `${userId}:${modeRequest.id}`);
      if (limited) return limited;
      const denied = await verifySessionAccess(client, modeRequest.id);
      if (denied) return denied;
      return await runSerialized(modeRequest.id, () => (modeRequest.mode === "human" ? handleTakeover(modeRequest.id) : handleHandback(modeRequest.id)));
    } catch (unexpected) {
      logError("POST failed", unexpected);
      return json({ error: "Belső szerverhiba." }, 500);
    }
  },
    },
  },
});
```[browser.ts](https://files.use.ai/files/chat%2Ffiles%2Fd7170d03a4b76d9ba01ce8e1db85665cf68668155c4e1006460e734cba78a608%2Fbrowser.ts?v=1792326103069)
