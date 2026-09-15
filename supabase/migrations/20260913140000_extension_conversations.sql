-- Conversations that follow the account rather than the device.
--
-- WHY. The browser extension keeps its history in `chrome.storage.local`, which is
-- one browser profile on one machine. Someone who asks a question on their laptop
-- and opens the panel on their desktop finds an empty panel — and the desktop app
-- and the launchpad, which authenticate the SAME Supabase user, cannot see any of
-- it either. These two tables are that shared history.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE EGRESS RULE, AND IT IS A CONSTRAINT HERE RATHER THAN A PROMISE IN THE CLIENT
-- ─────────────────────────────────────────────────────────────────────────────
-- RAW TOOL RESULTS NEVER LEAVE THE DEVICE. What syncs is what was SAID: the
-- user's messages, the assistant's replies, and compaction summaries. A tool
-- result syncs as its one-line label ("Reading example.com") and nothing more.
--
-- Three reasons, and the first is the one that decides it:
--
--   1. It is the user's browsing, in detail. A page read is the contents of
--      whatever they were looking at — an inbox, a bank dashboard, a medical
--      portal. There is no version of "helpful history" that justifies copying
--      that to a server, and the fact that it is their own row does not change
--      what it is.
--   2. It is regenerable. The page can be read again. Storing the one part of a
--      conversation that can be reproduced, at the cost of the part that cannot,
--      is the wrong trade in both directions.
--   3. It is the bulk. A page read is tens of kilobytes against a question of
--      tens of bytes, and this project has already had a Free-tier overage this
--      month.
--
-- `content_length_by_role` is what makes it structural. A client bug, a future
-- refactor or a patched extension cannot push a page snapshot through a column
-- that refuses one: a `tool_label` row is capped at 200 characters, which is a
-- label and cannot be a page. A rule enforced only in the code that happens to
-- call it is a rule that holds until someone writes a second caller.
--
-- RLS IS ON auth.uid() ON BOTH TABLES. `conversation_messages` carries its own
-- `user_id` rather than reaching through `conversation_id` — a policy that joins
-- runs the join for every row read, and a denormalised column that the FK and
-- the policy both constrain cannot drift out of step with its parent.

-- ---------------------------------------------------------------------------
-- 1. Conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversations (
  -- The id the DEVICE generated. Not a server sequence: the extension creates a
  -- conversation offline, writes to it, and may sync minutes later or never.
  -- Letting the client name it makes the sync an idempotent upsert instead of a
  -- two-phase "create, learn the id, then write".
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  -- Which product this came from: 'extension', 'app'. A label for display and
  -- for telling the surfaces apart later; never a permission.
  surface text NOT NULL DEFAULT 'extension',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_title_length CHECK (char_length(title) <= 200),
  CONSTRAINT conversations_surface_known CHECK (surface IN ('extension', 'app'))
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON public.conversations (user_id, updated_at DESC);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversations_select_own" ON public.conversations;
CREATE POLICY "conversations_select_own" ON public.conversations
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "conversations_insert_own" ON public.conversations;
CREATE POLICY "conversations_insert_own" ON public.conversations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- USING and WITH CHECK both, and they are not the same clause. USING decides
-- which rows may be updated; WITH CHECK decides what they may be updated TO.
-- With only USING, a user could update their own row and set `user_id` to
-- somebody else's — moving a conversation into another account.
DROP POLICY IF EXISTS "conversations_update_own" ON public.conversations;
CREATE POLICY "conversations_update_own" ON public.conversations
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "conversations_delete_own" ON public.conversations;
CREATE POLICY "conversations_delete_own" ON public.conversations
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 'tool_label' is deliberately NOT 'tool'. The name says what the row holds:
  -- the one-line label of a tool call, never its result. Calling it 'tool' would
  -- invite exactly the write this table exists to prevent.
  role text NOT NULL,
  content text NOT NULL,
  -- Position within the conversation, assigned by the device. The unique index
  -- below is what makes a re-sync an upsert rather than a duplicate.
  seq integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_role_known
    CHECK (role IN ('user', 'assistant', 'tool_label', 'compaction')),
  CONSTRAINT conversation_messages_seq_nonneg CHECK (seq >= 0),
  -- THE EGRESS RULE, ENFORCED. 200 characters is a label; it is not a page.
  -- 40,000 is a generous ceiling for something a person or a model wrote, and
  -- still an order of magnitude below a page snapshot.
  CONSTRAINT content_length_by_role CHECK (
    CASE role
      WHEN 'tool_label' THEN char_length(content) <= 200
      ELSE char_length(content) <= 40000
    END
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_position_idx
  ON public.conversation_messages (conversation_id, seq);

CREATE INDEX IF NOT EXISTS conversation_messages_user_idx
  ON public.conversation_messages (user_id, created_at DESC);

ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversation_messages_select_own"
  ON public.conversation_messages;
CREATE POLICY "conversation_messages_select_own" ON public.conversation_messages
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "conversation_messages_insert_own"
  ON public.conversation_messages;
CREATE POLICY "conversation_messages_insert_own" ON public.conversation_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "conversation_messages_update_own"
  ON public.conversation_messages;
CREATE POLICY "conversation_messages_update_own" ON public.conversation_messages
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "conversation_messages_delete_own"
  ON public.conversation_messages;
CREATE POLICY "conversation_messages_delete_own" ON public.conversation_messages
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
-- EXPLICIT, because a fresh table lands with no privileges for `authenticated`
-- at all — which makes every policy above UNREACHABLE rather than merely wrong.
-- A policy narrows the rows a role may ALREADY read. Measured on this project's
-- own reviewer tables (20260825120000) and repeated here because the failure is
-- silent: the policies look right and every query returns nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_messages TO authenticated;
REVOKE ALL ON public.conversations FROM anon;
REVOKE ALL ON public.conversation_messages FROM anon;

COMMENT ON TABLE public.conversation_messages IS
  'What was SAID in a conversation. Raw tool results never land here — a tool call syncs as its one-line label, and content_length_by_role enforces that rather than trusting the client.';
