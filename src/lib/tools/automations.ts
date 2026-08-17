/**
 * `automations` — the agent can finally see the automations feature.
 *
 * The feature has existed for a while: `automations` + `automation_runs` tables,
 * cron / GitHub / MCP triggers, a runner, pollers, unattended auto-approve, a
 * notify path and a triage feed. Until v14.27.0 `grep -rn "automation"` across
 * every prompt, context section and skill returned ZERO hits — so the actor best
 * placed to notice "you have checked CI by hand three times today" had no idea
 * any of it existed.
 *
 * MODE-PARAMETERISED, like `plan` and `mcp_call`, so the standing prompt cost is
 * one tool description rather than five.
 *
 * `list` is free. `create` / `update` / `delete` return a `__permission_required`
 * envelope and reach the database only after the user approves — because a
 * standing, recurring, possibly token-spending job that runs while nobody is
 * watching is a different risk class from a one-shot file edit, and a silently
 * deleted automation leaves nothing on disk to notice.
 */

import log from "electron-log";
import {
  ToolRegistry,
  createParameters,
  stringParam,
  enumParam,
  booleanParam,
  numberParam,
} from "./registry";
import {
  AutomationInputSchema,
  MIN_POLL_INTERVAL_MINUTES,
  type AutomationInput,
  type AutomationTrigger,
} from "@/lib/automations/types";
import { listAutomations, getAutomation } from "@/lib/automations/service";
import { SubscriptionManager } from "@/lib/SubscriptionManager";
import { capRemedy, describePlanCap, planCapClause } from "@/lib/plan-caps";
import { pipelineHostIds } from "@/lib/automations/pipeline-hosts";

const logger = log.scope("automations-tool");

/**
 * How long operation:"run" waits before handing back and letting the result
 * arrive on its own. Mirrors run_command PROMOTE_AFTER_MS so the model meets one
 * behaviour, not two.
 */
const AUTOMATION_RUN_PROMOTE_AFTER_MS = 15_000;

/** Plain-English trigger, for the approval card and the model's own summary. */
export function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "schedule") return `on the schedule \`${trigger.cron}\``;
  if (trigger.kind === "pipeline") {
    return `on ${trigger.events.join(" / ")} in ${trigger.repo} (${trigger.host}), polled every ${trigger.intervalMinutes} min`;
  }
  return `by polling MCP tool \`${trigger.tool}\` every ${trigger.intervalMinutes} min`;
}

type AutomationsToolArgs = {
  operation: "list" | "create" | "update" | "delete" | "set_notify" | "run";
  workspaceId?: number;
  automation_id?: string;
  name?: string;
  trigger?: unknown;
  prompt?: string;
  run_mode?: "notify-only" | "read-only";
  notify_agent?: boolean;
  enabled?: boolean;
};

/** Shape a create/update payload, so both paths validate identically. */
function buildInput(args: AutomationsToolArgs, existing?: {
  name: string;
  trigger: unknown;
  prompt: string;
  runMode: "notify-only" | "read-only";
  notifyAgent: boolean;
  enabled: boolean;
}): AutomationInput {
  return AutomationInputSchema.parse({
    name: args.name ?? existing?.name,
    enabled: args.enabled ?? existing?.enabled ?? true,
    trigger: args.trigger ?? existing?.trigger,
    prompt: args.prompt ?? existing?.prompt ?? "",
    runMode: args.run_mode ?? existing?.runMode ?? "notify-only",
    notifyAgent: args.notify_agent ?? existing?.notifyAgent,
    model: null,
  });
}

ToolRegistry.register({
  name: "automations",
  description:
    "Standing background watches on a schedule, a GitHub event, or an MCP tool poll — the thing to reach for when the user keeps checking something by hand. " +
    "operation:\"list\" — every automation in this workspace with its trigger, runMode, notifyAgent and last run. Free; start here. " +
    "operation:\"create\" — name + trigger + run_mode + notify_agent. " +
    "operation:\"update\" — automation_id plus only the fields you are changing. " +
    "operation:\"delete\" — automation_id. " +
    "operation:\"set_notify\" — automation_id + notify_agent; the cheap way to change only who hears about runs. " +
    "\n" +
    "`notify_agent` is REQUIRED on create and is the most important choice you make: " +
    "true means each finished run is delivered to you in your next turn (right for CI, tests, builds — things to ACT on); " +
    "false means the user is notified and you are not, so the automation cannot spend tokens (right for Slack/MCP inbox noise the user triages themselves, then tells you about). " +
    "Say which you chose and why IN YOUR REPLY, not only in the call — it decides whether this costs money while nobody is watching, and the user should not have to infer it. Either of you can flip it later with set_notify. " +
    "\n" +
    "`run_mode` is separate: \"notify-only\" (default) posts the fired trigger with no model involved; \"read-only\" runs an unattended agent turn with read-only tools and costs a model turn per fire — it needs a `prompt`. " +
    "\n" +
    "PROPOSE, DO NOT SELF-START. Offer an automation when you have watched the user do the same check repeatedly, and create it once they agree. Do not set up watches on GitHub, Slack, CI or anything else the user has not asked for. create/update/delete all require the user's approval before anything is written. " +
    "An MCP trigger also records standing consent for that tool (the poller runs unattended and cannot prompt) — say so when you propose one. " +
    "\n" +
    planCapClause("automations"),
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  // Available in every mode: an automation is not a workspace mutation, and the
  // approval gate is the control (owner's call). `list` in particular is what
  // makes recommendation possible from Explore, where the user is most likely to
  // be doing the manual checking that should become an automation.
  allowInAskMode: true,
  parameters: createParameters(
    {
      operation: enumParam("What to do", "list", [
        "list",
        "create",
        "update",
        "delete",
        "set_notify",
        "run",
      ]),
      automation_id: stringParam("Which automation (update / delete / set_notify / run)."),
      name: stringParam("Short human name, e.g. \"CI failures on main\"."),
      trigger: {
        type: "object",
        description:
          "One of: {kind:\"schedule\", cron:\"0 9 * * 1-5\"} · " +
          `{kind:"pipeline", host:"<host>", repo:"owner/name", events:["new-pr"|"review-requested"|"ci-failed"], intervalMinutes:>=${MIN_POLL_INTERVAL_MINUTES}} — hosts Atlarix can poll right now: ${pipelineHostIds().join(", ") || "(none)"} · ` +
          `{kind:"mcp", serverId:<number>, tool:"<tool>", args:{…}, intervalMinutes:>=${MIN_POLL_INTERVAL_MINUTES}}`,
      },
      prompt: stringParam(
        "What the agent should do on each fire. Required when run_mode is \"read-only\"; unused for \"notify-only\".",
      ),
      run_mode: enumParam(
        "Does a fire run the model unattended?",
        "notify-only",
        ["notify-only", "read-only"],
      ),
      notify_agent: booleanParam(
        "Does a finished run reach YOU (true) or only the user (false)? Required on create — there is no default, because this is what decides whether the automation can spend tokens.",
      ),
      enabled: booleanParam("Whether the automation is armed. Defaults to true."),
      workspaceId: numberParam("Injected by the harness."),
    },
    ["operation"],
  ),
  handler: async (rawArgs: unknown) => {
    const args = rawArgs as AutomationsToolArgs;
    const workspaceId = args.workspaceId;
    if (workspaceId == null) {
      return {
        success: false,
        error: "automations needs an open workspace.",
      };
    }

    if (args.operation === "list") {
      const { automations: rows } = await listAutomations(workspaceId);
      // Report the cap alongside the contents: the agent has no other way to
      // learn the user's tier (nothing in the prompt mentions a plan), so
      // without this a refused create reads as a broken workspace.
      const limits = describePlanCap(
        "automations",
        SubscriptionManager.isPro(),
        rows.length,
      );
      return {
        success: true,
        limits,
        automations: rows.map((a) => ({
          id: a.id,
          name: a.name,
          enabled: a.enabled,
          trigger: describeTrigger(a.trigger as AutomationTrigger),
          run_mode: a.runMode,
          notify_agent: a.notifyAgent,
          last_run_at: a.lastRunAt,
        })),
        note: !limits.canAddMore
          ? `At the ${limits.tier} limit of ${limits.max} automations. This is a plan limit, not a workspace problem. ${capRemedy("automations", limits.tier === "pro")}`
          : rows.length === 0
            ? "No automations yet. Offer one only if the user has been repeating a check by hand."
            : undefined,
      };
    }

    // Fire one NOW. Shaped exactly like `run_command`: if it finishes quickly
    // you get the outcome inline; if it does not, it moves to the background and
    // the result reaches you on its own. No new concept to learn.
    //
    // Not behind the approval gate below: this changes no configuration, and the
    // automation it runs was already approved when it was created. Its whole
    // purpose is "I just made this — does it work?", which a second prompt
    // defeats.
    if (args.operation === "run") {
      if (!args.automation_id) {
        return {
          success: false,
          error: 'operation:"run" requires automation_id (see operation:"list").',
        };
      }
      const existing = await getAutomation(args.automation_id);
      if (!existing) {
        return {
          success: false,
          error: `No automation with id ${args.automation_id}. Use operation:"list".`,
        };
      }
      if (!existing.enabled) {
        return {
          success: false,
          error: `"${existing.name}" is disabled — enable it with operation:"update" before running it.`,
        };
      }
      const { executeAutomationRun } = await import("@/lib/automations/execute-run");
      // forceNotifyAgent: you asked for this run, so you hear the outcome even
      // when notify_agent is false for its unattended fires.
      const runPromise = executeAutomationRun(
        args.automation_id,
        `Manual run requested by the agent (not a scheduled fire).`,
        undefined,
        { forceNotifyAgent: true },
      );
      let promoteTimer: NodeJS.Timeout | undefined;
      const finishedInTime = await Promise.race([
        runPromise.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          promoteTimer = setTimeout(() => resolve(false), AUTOMATION_RUN_PROMOTE_AFTER_MS);
        }),
      ]);
      if (promoteTimer) clearTimeout(promoteTimer);

      if (!finishedInTime) {
        return {
          success: true,
          status: "running",
          message:
            `"${existing.name}" is still running after ${AUTOMATION_RUN_PROMOTE_AFTER_MS / 1000}s — moved to the background. ` +
            `Its result reaches you automatically when it finishes; do not poll for it.`,
        };
      }

      const result = await runPromise.catch(() => null);
      if (!result) {
        return {
          success: false,
          error: `"${existing.name}" did not run. It may be disabled, or its workspace is missing.`,
        };
      }
      // Read the recorded outcome rather than reporting "started" as success —
      // a run that finished with an error is still a finished run.
      const { db } = await import("@/db");
      const { automationRuns } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const row = await db.query.automationRuns.findFirst({
        where: eq(automationRuns.id, result.runId),
      });
      return {
        success: true,
        run_id: result.runId,
        status: row?.status ?? "ok",
        summary: row?.summary ?? null,
        error: row?.status === "error" ? (row?.summary ?? "run failed") : undefined,
      };
    }

    // ── Everything below MUTATES, so it stops here and asks. ──────────────
    try {
      if (args.operation === "delete" || args.operation === "set_notify") {
        if (!args.automation_id) {
          return {
            success: false,
            error: `operation:"${args.operation}" requires automation_id (see operation:"list").`,
          };
        }
        const existing = await getAutomation(args.automation_id);
        if (!existing) {
          return {
            success: false,
            error: `No automation with id ${args.automation_id} — it may already be gone. Use operation:"list".`,
          };
        }
        if (args.operation === "delete") {
          return {
            __permission_required: true,
            operation: "automation_write",
            preview: {
              action: "delete" as const,
              name: existing.name,
              automationId: existing.id,
              triggerSummary: describeTrigger(existing.trigger as AutomationTrigger),
              description: `Delete the automation "${existing.name}"`,
            },
          };
        }
        if (typeof args.notify_agent !== "boolean") {
          return {
            success: false,
            error: 'operation:"set_notify" requires notify_agent (true or false).',
          };
        }
        return {
          __permission_required: true,
          operation: "automation_write",
          preview: {
            action: "update" as const,
            name: existing.name,
            automationId: existing.id,
            triggerSummary: describeTrigger(existing.trigger as AutomationTrigger),
            runMode: existing.runMode,
            notifyAgent: args.notify_agent,
            description: args.notify_agent
              ? `Start telling the agent about "${existing.name}" runs`
              : `Stop telling the agent about "${existing.name}" runs`,
            changes: [
              `notifyAgent: ${existing.notifyAgent} → ${args.notify_agent}`,
            ],
          },
        };
      }

      if (args.operation === "create") {
        const input = buildInput(args);
        return {
          __permission_required: true,
          operation: "automation_write",
          preview: {
            action: "create" as const,
            name: input.name,
            triggerSummary: describeTrigger(input.trigger),
            runMode: input.runMode,
            notifyAgent: input.notifyAgent,
            description: `Create "${input.name}" — runs ${describeTrigger(input.trigger)}`,
            input,
            ...(input.trigger.kind === "mcp"
              ? { grantsMcpConsent: input.trigger.tool }
              : {}),
          },
        };
      }

      // update
      if (!args.automation_id) {
        return {
          success: false,
          error: 'operation:"update" requires automation_id (see operation:"list").',
        };
      }
      const existing = await getAutomation(args.automation_id);
      if (!existing) {
        return {
          success: false,
          error: `No automation with id ${args.automation_id}. Use operation:"list".`,
        };
      }
      const input = buildInput(args, {
        name: existing.name,
        trigger: existing.trigger,
        prompt: existing.prompt,
        runMode: existing.runMode,
        notifyAgent: existing.notifyAgent,
        enabled: existing.enabled,
      });
      const changes: string[] = [];
      if (input.name !== existing.name) {
        changes.push(`name: "${existing.name}" → "${input.name}"`);
      }
      if (input.runMode !== existing.runMode) {
        changes.push(`runMode: ${existing.runMode} → ${input.runMode}`);
      }
      if (input.notifyAgent !== existing.notifyAgent) {
        changes.push(`notifyAgent: ${existing.notifyAgent} → ${input.notifyAgent}`);
      }
      if (input.enabled !== existing.enabled) {
        changes.push(`enabled: ${existing.enabled} → ${input.enabled}`);
      }
      if (args.trigger != null) changes.push("trigger changed");
      if (changes.length === 0) {
        return {
          success: true,
          message: "Nothing to change — the automation already matches that.",
        };
      }
      return {
        __permission_required: true,
        operation: "automation_write",
        preview: {
          action: "update" as const,
          name: input.name,
          automationId: existing.id,
          triggerSummary: describeTrigger(input.trigger),
          runMode: input.runMode,
          notifyAgent: input.notifyAgent,
          description: `Update "${existing.name}"`,
          changes,
          input,
          ...(input.trigger.kind === "mcp"
            ? { grantsMcpConsent: input.trigger.tool }
            : {}),
        },
      };
    } catch (e) {
      // A zod failure here is usually a missing `notify_agent` or a malformed
      // trigger. Return it as the message rather than a generic failure — the
      // model can fix either from the text.
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(`automations ${args.operation} rejected: ${message}`);
      return {
        success: false,
        error: `Could not build that automation: ${message}`,
      };
    }
  },
});
