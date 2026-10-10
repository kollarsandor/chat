import { createFileRoute } from "@tanstack/react-router";
import { Inngest } from "inngest";
import { serve } from "inngest/edge";

const inngest = new Inngest({ id: "orca-chat" });

const chatRequested = inngest.createFunction(
  { id: "orca-chat-requested", retries: 2, triggers: [{ event: "orca/chat.requested" }] },
  async ({ event, step }) => {
    const jobId = String((event.data as { jobId?: unknown })?.jobId ?? "");
    if (!jobId) return { status: "missing" };
    const result = await step.run("execute-chat-job", async () => {
      const { executeChatJob } = await import("@/lib/chat-jobs.server");
      return executeChatJob(jobId);
    });
    return result;
  }
);

const handler = serve({ client: inngest, functions: [chatRequested] });

export const Route = createFileRoute("/api/inngest")({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
      PUT: ({ request }) => handler(request),
    },
  },
});
