CREATE TABLE public.chat_conversations (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Beszélgetés',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.chat_conversations TO service_role;
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.chat_jobs (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  history JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  response_content TEXT NOT NULL DEFAULT '',
  response_reasoning TEXT NOT NULL DEFAULT '',
  error TEXT,
  stop_requested BOOLEAN NOT NULL DEFAULT false,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_jobs_status_check CHECK (status IN ('queued','running','completed','failed','cancelled'))
);
GRANT ALL ON public.chat_jobs TO service_role;
ALTER TABLE public.chat_jobs ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX chat_jobs_one_active_per_conversation ON public.chat_jobs(conversation_id) WHERE status IN ('queued','running');
CREATE INDEX chat_jobs_conversation_created_idx ON public.chat_jobs(conversation_id, created_at DESC);

CREATE TABLE public.chat_job_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES public.chat_jobs(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.chat_job_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.chat_job_events_id_seq TO service_role;
ALTER TABLE public.chat_job_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX chat_job_events_job_id_id_idx ON public.chat_job_events(job_id, id);
