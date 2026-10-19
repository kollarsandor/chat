import { createFileRoute } from "@tanstack/react-router";

const FLYMYAI_EDIT_ENDPOINT = "https://api.flymy.ai/api/v1/flymyai/gpt-image-2-5-sunburst_edit/predict";
const UPSTREAM_TIMEOUT_MS = 300_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 32_000;
const ALLOWED_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const SIZE_PATTERN = /^(?:auto|[1-9]\d{2,3}x[1-9]\d{2,3})$/;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

type FieldResult = { ok: true; value: string } | { ok: false };

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function readTextField(form: FormData, name: string, fallback: string): FieldResult {
  const value = form.get(name);
  if (value === null) return { ok: true, value: fallback };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed || fallback };
}

function extractUpstreamMessage(body: unknown): string | null {
  if (typeof body === "string") return body.trim() ? body.trim().slice(0, 500) : null;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "detail", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>)["message"];
      if (typeof nested === "string" && nested.trim()) return nested.trim().slice(0, 500);
    }
  }
  return null;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export const Route = createFileRoute("/api/images/edits")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["FLYMYAI_API_KEY"]?.trim();
        if (!apiKey) return jsonResponse({ message: "A FlyMyAI kulcs nincs beállítva." }, 503);

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return jsonResponse({ message: "A képfeltöltés nem olvasható." }, 400);
        }

        const image = form.get("image");
        const rawPrompt = form.get("prompt");
        const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
        if (!(image instanceof File) || image.size === 0 || !prompt) {
          return jsonResponse({ message: "Adj meg egy kiinduló képet és képleírást." }, 400);
        }

        const extension = IMAGE_EXTENSIONS[image.type];
        if (!extension) {
          return jsonResponse({ message: "Csak PNG, JPEG vagy WebP kép tölthető fel." }, 415);
        }
        if (image.size > MAX_IMAGE_BYTES) {
          return jsonResponse({ message: "A kép legfeljebb 50 MB lehet." }, 413);
        }
        if (prompt.length > MAX_PROMPT_LENGTH) {
          return jsonResponse({ message: `A képleírás legfeljebb ${MAX_PROMPT_LENGTH} karakter lehet.` }, 400);
        }

        const quality = readTextField(form, "quality", "medium");
        if (!quality.ok || !ALLOWED_QUALITIES.has(quality.value)) {
          return jsonResponse({ message: "Érvénytelen minőség. Választható: low, medium, high, auto." }, 400);
        }

        const size = readTextField(form, "size", "1024x1024");
        if (!size.ok || !SIZE_PATTERN.test(size.value)) {
          return jsonResponse({ message: "Érvénytelen képméret. Használj SZÉLESSÉGxMAGASSÁG formátumot vagy az auto értéket." }, 400);
        }

        const fileName = image.name && image.name.trim() ? image.name.trim() : `image.${extension}`;
        const payload = new FormData();
        payload.append("image", image, fileName);
        payload.append("prompt", prompt);
        payload.append("quality", quality.value);
        payload.append("size", size.value);

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, UPSTREAM_TIMEOUT_MS);
        const abortFromClient = () => controller.abort();
        if (request.signal.aborted) controller.abort();
        else request.signal.addEventListener("abort", abortFromClient, { once: true });

        let upstreamStatus: number;
        let upstreamOk: boolean;
        let upstreamBody: unknown;
        try {
          const upstream = await fetch(FLYMYAI_EDIT_ENDPOINT, {
            method: "POST",
            headers: { "X-API-KEY": apiKey, Accept: "application/json" },
            body: payload,
            signal: controller.signal,
          });
          upstreamStatus = upstream.status;
          upstreamOk = upstream.ok;
          upstreamBody = parseBody(await upstream.text());
        } catch {
          if (timedOut) {
            return jsonResponse({ message: "A FlyMyAI nem válaszolt időben; próbáld újra később." }, 504);
          }
          if (request.signal.aborted) {
            return jsonResponse({ message: "A kérés megszakadt." }, 499);
          }
          return jsonResponse({ message: "A FlyMyAI nem érhető el; próbáld újra később." }, 502);
        } finally {
          clearTimeout(timer);
          request.signal.removeEventListener("abort", abortFromClient);
        }

        if (!upstreamOk) {
          const detail = extractUpstreamMessage(upstreamBody);
          if (upstreamStatus === 401 || upstreamStatus === 403) {
            return jsonResponse({ message: "A FlyMyAI elutasította a kulcsot." }, 502);
          }
          if (upstreamStatus === 429) {
            return jsonResponse({ message: "Túl sok kérés érkezett a FlyMyAI felé; próbáld újra később." }, 429);
          }
          if (upstreamStatus === 400 || upstreamStatus === 413 || upstreamStatus === 415 || upstreamStatus === 422) {
            return jsonResponse({ message: detail ? `A FlyMyAI elutasította a kérést: ${detail}` : "A FlyMyAI elutasította a kérést." }, 400);
          }
          return jsonResponse({ message: detail ? `A FlyMyAI hibát jelzett: ${detail}` : "A FlyMyAI hibát jelzett; próbáld újra később." }, 502);
        }

        if (!upstreamBody || typeof upstreamBody !== "object") {
          return jsonResponse({ message: "A FlyMyAI érvénytelen választ adott." }, 502);
        }

        return jsonResponse(upstreamBody, 200);
      },
    },
  },
});
