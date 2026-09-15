-- ---------------------------------------------------------------------------
-- Stop publishing public.users to Realtime. Nothing has subscribed since the
-- client channel was removed.
-- ---------------------------------------------------------------------------
--
-- WHAT THIS COST, measured 2026-09-14 on the live database with
-- `pg_stat_statements`:
--
--   SELECT wal->>$5 as type, wal->>$6 as schema, ...   7,327,496 calls
--                                                      93.3% of ALL db time
--
-- That is Realtime polling the write-ahead log. Three statements, the top three
-- by total time, together 93.3%. Everything the product actually does -- every
-- chat turn, every debit, every account page load -- shared the remaining 6.7%.
--
-- NOTHING WAS LISTENING. The client channel was removed some time ago and the
-- code says so in two places: `SubscriptionManager.ts` reads "Was: open a
-- realtime channel. Now a single read on sign-in, with focus refreshes after
-- it", and `main.ts` records that the realtime keepalive "is gone". Only the
-- PUBLICATION was left behind -- so Postgres kept doing the whole job for a
-- subscriber that had stopped existing.
--
-- THIS IS THE SECOND TIME. `docs/TODO.md` already records realtime at "93.5% of
-- DB time" from an earlier session. It was diagnosed, the client was fixed, and
-- the publication was never touched -- which is why this is a MIGRATION rather
-- than the `ALTER PUBLICATION` someone runs in the SQL editor and forgets. A
-- hand-run change to a live database is a change that comes back.
--
-- AFTER: 152 statements total in the minutes following a counter reset, and the
-- WAL poll does not appear at all.
--
-- IF REALTIME IS EVER WANTED AGAIN, add back only the table that something
-- actually subscribes to, in the same commit as the subscriber:
--
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.<table>;
--
-- and delete it in the same commit that removes the subscriber. A publication
-- entry with no listener is pure cost with no symptom.

BEGIN;

DO $$
BEGIN
  -- Idempotent: this was applied by hand on 2026-09-14 before being written
  -- down, and a re-run on a database that never had it must not fail.
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'users'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.users;
  END IF;
END;
$$;

COMMIT;
