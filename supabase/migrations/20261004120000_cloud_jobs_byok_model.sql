-- ---------------------------------------------------------------------------
-- cloud_jobs: which provider and model an own-key run used.
--
-- `tier = 'byok'` already says the user paid their provider, not us; it did not
-- say WHICH provider, because that lives in the user's repository variables. The
-- runner reports both when it finishes (never the key). Null for Core runs, and
-- for own-key runs from a runner older than atlarix-agent-action v1.1.0.
-- Written by the reviewer's service role like every other column; the owner's
-- read policy already covers new columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.cloud_jobs
  ADD COLUMN IF NOT EXISTS byok_provider text
    CHECK (byok_provider IS NULL OR byok_provider ~ '^[a-z0-9_-]{1,40}$'),
  ADD COLUMN IF NOT EXISTS byok_model text
    CHECK (byok_model IS NULL OR (char_length(byok_model) BETWEEN 1 AND 120 AND byok_model !~ '[[:cntrl:]]'));

COMMENT ON COLUMN public.cloud_jobs.byok_provider IS
  'Own-key runs only: the provider id the runner used (e.g. deepseek). Null on Core runs.';
COMMENT ON COLUMN public.cloud_jobs.byok_model IS
  'Own-key runs only: that provider''s model id. Null on Core runs.';
