import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/browser")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const conversation = query.get("conversation");
        if (conversation && /^[a-f0-9-]{36}$/i.test(conversation)) {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: jobs } = await supabaseAdmin.from("chat_jobs").select("id").eq("conversation_id", conversation).order("created_at", { ascending: false }).limit(20);
          if (!jobs?.length) return Response.json({ sessions: [] });
          const { data } = await supabaseAdmin.from("chat_browser_sessions").select("id,control_mode,status,created_at").in("job_id", jobs.map((job) => job.id)).order("created_at", { ascending: false });
          return Response.json({ sessions: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
        }
        const id = query.get("id") ?? "";
        if (!/^[a-f0-9-]{36}$/i.test(id)) return Response.json({ error: "Érvénytelen böngészőnézet." }, { status: 400 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.from("chat_browser_sessions").select("id,cdp_url,live_url,control_mode,status").eq("id", id).maybeSingle();
        if (error || !data) return Response.json({ error: "A böngészőnézet nem található." }, { status: 404 });
        if (query.has("frame") && data.status === "active") {
          try {
            const { browserCommand } = await import("@/lib/browser-cdp.server");
            return Response.json({ ...(await browserCommand(data.cdp_url, "frame")), control_mode: data.control_mode, status: data.status }, { headers: { "Cache-Control": "private, no-store" } });
          } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "A képernyő nem érhető el." }, { status: 502 }); }
        }
        return Response.json({ id: data.id, control_mode: data.control_mode, status: data.status }, { headers: { "Cache-Control": "private, no-store" } });
      },
      POST: async ({ request }) => {
        const body = await request.json().catch(() => null);
        if (body && typeof body.id === "string" && /^[a-f0-9-]{36}$/i.test(body.id) && body.input) {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data } = await supabaseAdmin.from("chat_browser_sessions").select("cdp_url,control_mode,status").eq("id", body.id).maybeSingle();
          if (!data || data.status !== "active" || data.control_mode !== "human") return Response.json({ error: "Előbb vedd át az irányítást." }, { status: 409 });
          const input = body.input;
          const mouse = ["mouse", "wheel"].includes(input.kind) && ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(input.type) && Number.isFinite(input.x) && Number.isFinite(input.y) && input.x >= 0 && input.x <= 1280 && input.y >= 0 && input.y <= 1029 && (input.kind !== "wheel" || (Number.isFinite(input.deltaX) && Number.isFinite(input.deltaY)));
          const key = input.kind === "key" && ["keyDown", "keyUp"].includes(input.type) && typeof input.key === "string" && input.key.length <= 40 && typeof input.code === "string" && input.code.length <= 40 && Number.isInteger(input.keyCode) && Number.isInteger(input.modifiers);
          const text = input.kind === "text" && typeof input.text === "string" && input.text.length > 0 && input.text.length <= 10000;
          if (!mouse && !key && !text) return Response.json({ error: "Érvénytelen bevitel." }, { status: 400 });
          try {
            const { browserCommand } = await import("@/lib/browser-cdp.server");
            return Response.json(await browserCommand(data.cdp_url, "input", input));
          } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "A bevitel sikertelen." }, { status: 502 }); }
        }
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