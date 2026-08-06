-- v14.27.0: `kind:"github"` triggers become `kind:"pipeline"` with `host:"github"`.
--
-- The vendor was the trigger KIND, which made it a schema branch, a poller call
-- and a form tab all named after one service — so adding GitLab meant repeating
-- every one of them. The kind is now `pipeline` and the vendor is a field
-- resolved through a poller registry (`lib/automations/pipeline-hosts.ts`).
--
-- Rewritten in place rather than left to the runtime alias, so exactly one shape
-- exists on disk. `AutomationTriggerSchema` still ACCEPTS the old shape and
-- normalises it — that covers a row written by an older build between this
-- migration and the next launch, not the rows already here.
--
-- json_set/json_remove are used rather than string surgery so a trigger with
-- unusual whitespace or key order migrates correctly; SQLite has shipped JSON1
-- by default since 3.38 and better-sqlite3 bundles a far newer build.
UPDATE automations
SET trigger = json_set(
      json_set(trigger, '$.kind', 'pipeline'),
      '$.host', 'github'
    )
WHERE json_valid(trigger)
  AND json_extract(trigger, '$.kind') = 'github';
