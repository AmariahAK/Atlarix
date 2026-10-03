-- Sign the CLI in on a machine with no browser (SSH, a server, a container):
-- `atlarix login --device` shows a code, the user signs in on ANY device at
-- atlarix.dev/auth/cli, types the code, and approves. RFC 8628's shape; the
-- edge function `cli-device` is the only reader and writer.
--
-- What this table never holds in the clear:
--   * the device code — only its SHA-256. The CLI holds the code; a database
--     read cannot be turned into a poll.
--   * the session — `sealed_session` is encrypted to a key pair the CLI made for
--     this one sign-in (ECDH P-256 → HKDF → AES-GCM). Only the CLI that started
--     the sign-in holds the private half, so a row read from here, a backup or a
--     log gives nobody a session.
--
-- Rows live ten minutes. A poll that collects an approved session deletes the
-- row in the same statement; the function also clears expired rows as it goes.

CREATE TABLE IF NOT EXISTS public.cli_device_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE,
  -- XXXX-XXXX from a 20-letter alphabet with no vowels or look-alikes.
  user_code text NOT NULL UNIQUE,
  -- The CLI's one-time ECDH public key (raw P-256 point, base64url).
  client_public_key text NOT NULL,
  -- What the CLI says it is ("macOS · my-laptop"). Shown on the approve page as
  -- a hint ONLY: the CLI chooses it, so it proves nothing.
  client_label text,
  -- Hash of the starting IP, to cap how many pending codes one address holds.
  client_ip_hash text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  sealed_session text,
  approved_by uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_polled_at timestamptz,
  CONSTRAINT cli_device_codes_sealed_when_approved
    CHECK ((status = 'approved') = (sealed_session IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS cli_device_codes_expires_at ON public.cli_device_codes (expires_at);
CREATE INDEX IF NOT EXISTS cli_device_codes_ip_pending
  ON public.cli_device_codes (client_ip_hash) WHERE status = 'pending';

ALTER TABLE public.cli_device_codes ENABLE ROW LEVEL SECURITY;
-- No policies: no user reads or writes this table, only the service role
-- through `cli-device`.
REVOKE ALL ON public.cli_device_codes FROM PUBLIC;
REVOKE ALL ON public.cli_device_codes FROM authenticated, anon;
REVOKE TRUNCATE, MAINTAIN ON public.cli_device_codes FROM service_role;

-- Verify after applying:
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'cli_device_codes' ORDER BY 1, 2;
-- Expect service_role only (no TRUNCATE / MAINTAIN), nothing for anon/authenticated.
