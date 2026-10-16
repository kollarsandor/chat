import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/browser")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!/^[a-f0-9-]{36}$/i.test(id)) return Response.json({ error: "Érvénytelen böngészőnézet." }, { status: 400 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.from("chat_browser_sessions").select("id,cdp_url,live_url,control_mode,status").eq("id", id).maybeSingle();
        if (error || !data) return Response.json({ error: "A böngészőnézet nem található." }, { status: 404 });
        return Response.json(data, { headers: { "Cache-Control": "private, no-store" } });
      },
      POST: async ({ request }) => {
        const body = await request.json().catch(() => null);
        if (!body || typeof body.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id) || !["human", "agent"].includes(body.mode)) return Response.json({ error: "Érvénytelen irányítási kérés." }, { status: 400 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.from("chat_browser_sessions").update({ control_mode: body.mode === "human" ? "requested" : "agent" }).eq("id", body.id).eq("status", "active").select("id,job_id,agent_busy,control_mode").maybeSingle();
        if (error || !data) return Response.json({ error: "A böngésző már leállt." }, { status: 409 });
        if (body.mode === "human") await supabaseAdmin.from("chat_browser_sessions").update({ control_mode: "human" }).eq("id", body.id).eq("agent_busy", false).eq("control_mode", "requested");
        if (body.mode === "agent") {
          const { postOperatorMessage } = await import("@/lib/cognitive.server");
          await postOperatorMessage(data.job_id, "A felhasználó visszaadta a böngésző irányítását. Vizsgáld meg az aktuális oldalt, és onnan folytasd; ne ismételd meg a már elvégzett műveleteket.");
        }
        return Response.json({ ok: true });
      },
    },
  },
});