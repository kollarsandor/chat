import type { AgentEvent, AgentSink, ChatMessage } from "@/routes/api/chat";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/inngest/e/";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function enqueueChatJob(jobId: string): Promise<void> {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const inngestKey = process.env["INNGEST_API_KEY"];
  if (!lovableKey || !inngestKey) throw new Error("A háttérmunka szolgáltatása nincs beállítva.");
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": inngestKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "orca/chat.requested", data: { jobId } }),
  });
  if (!response.ok) throw new Error(`A háttérmunka indítása sikertelen (${response.status}).`);
}

export async function executeChatJob(jobId: string): Promise<{ status: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: job } = await supabaseAdmin.from("chat_jobs").select("id,history,status,lease_expires_at").eq("id", jobId).maybeSingle();
  if (!job || job.status === "completed" || job.status === "cancelled") return { status: job?.status ?? "missing" };
  const now = new Date();
  if (job.status === "running" && job.lease_expires_at && new Date(job.lease_expires_at) > now) return { status: "running" };
  const lease = new Date(now.getTime() + 21_900_000).toISOString();
  const { data: claimed } = await supabaseAdmin.from("chat_jobs").update({ status: "running", started_at: now.toISOString(), updated_at: now.toISOString(), lease_expires_at: lease }).eq("id", jobId).in("status", ["queued", "failed", "running"]).select("id").maybeSingle();
  if (!claimed) return { status: "running" };

  const controller = new AbortController();
  let content = "";
  let reasoning = "";
  let finalStatus = "failed";
  const sink: AgentSink = {
    async send(event: AgentEvent) {
      const { data: state } = await supabaseAdmin.from("chat_jobs").select("stop_requested").eq("id", jobId).single();
      if (state?.stop_requested) controller.abort(new Error("A munkát leállították."));
      if (event.type === "delta") {
        content += text(event.content);
        reasoning += text(event.reasoning_content);
      }
      if (event.type === "done") finalStatus = event.outcome === "completed" ? "completed" : event.outcome === "cancelled" ? "cancelled" : "failed";
      await supabaseAdmin.from("chat_job_events").insert({ job_id: jobId, payload: event });
      await supabaseAdmin.from("chat_jobs").update({ response_content: content, response_reasoning: reasoning, updated_at: new Date().toISOString() }).eq("id", jobId);
    },
    async enqueue(value: string) {
      if (value.includes("[DONE]") && finalStatus === "failed") finalStatus = "completed";
    },
  };
  try {
    const { runDurableChat } = await import("@/routes/api/chat");
    await runDurableChat(jobId, job.history as ChatMessage[], sink, controller.signal);
  } catch (error) {
    finalStatus = controller.signal.aborted ? "cancelled" : "failed";
    await sink.send({ type: "error", task_id: jobId, code: "BACKGROUND_FAILURE", message: error instanceof Error ? error.message : "A háttérmunka hibával leállt." });
  }
  await supabaseAdmin.from("chat_jobs").update({ status: finalStatus, error: finalStatus === "failed" ? "A háttérmunka hibával leállt." : null, finished_at: new Date().toISOString(), lease_expires_at: null, updated_at: new Date().toISOString() }).eq("id", jobId);
  return { status: finalStatus };
}

const FOLLOW_POLL_MS = 800;
const FOLLOW_HEARTBEAT_MS = 15000;
const FOLLOW_MAX_MS = 21_600_000;

export function followChatJob(jobId: string, after: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = after;
      let closed = false;
      const startedAt = Date.now();
      let lastHeartbeat = 0;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };
      signal.addEventListener("abort", close, { once: true });
      const push = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      while (!closed && !signal.aborted) {
        if (Date.now() - startedAt > FOLLOW_MAX_MS) {
          push(`data: ${JSON.stringify({ type: "error", task_id: jobId, code: "RUNTIME_LIMIT", message: "Lejárt a teljes feladathatáridő." })}\n\n`);
          break;
        }
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: events } = await supabaseAdmin
            .from("chat_job_events")
            .select("id,payload")
            .eq("job_id", jobId)
            .gt("id", cursor)
            .order("id", { ascending: true })
            .limit(200);
          let terminal = false;
          for (const row of events ?? []) {
            cursor = Math.max(cursor, row.id);
            const payload = row.payload as { type?: string };
            push(`id: ${row.id}\ndata: ${JSON.stringify(payload)}\n\n`);
            if (payload?.type === "done" || payload?.type === "error") terminal = true;
          }
          if (terminal) break;
          const { data: job } = await supabaseAdmin.from("chat_jobs").select("status").eq("id", jobId).single();
          if (!job || (job.status !== "queued" && job.status !== "running")) {
            const { data: rest } = await supabaseAdmin
              .from("chat_job_events")
              .select("id,payload")
              .eq("job_id", jobId)
              .gt("id", cursor)
              .order("id", { ascending: true })
              .limit(200);
            for (const row of rest ?? []) {
              cursor = Math.max(cursor, row.id);
              push(`id: ${row.id}\ndata: ${JSON.stringify(row.payload)}\n\n`);
            }
            break;
          }
        } catch (error) {
          push(`data: ${JSON.stringify({ type: "error", task_id: jobId, code: "FOLLOW_FAILURE", message: error instanceof Error ? error.message : "Az eseményfolyam megszakadt." })}\n\n`);
          break;
        }
        const now = Date.now();
        if (now - lastHeartbeat >= FOLLOW_HEARTBEAT_MS) {
          lastHeartbeat = now;
          push(`: heartbeat\n\n`);
        }
        await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
      }
      close();
    },
    cancel() {},
  });
}
