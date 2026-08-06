/**
 * Automation trigger + definition types, zod-validated at the IPC boundary.
 */

import { z } from "zod";

/** Poll intervals are clamped to this floor — pollers are deterministic but still cost API quota. */
export const MIN_POLL_INTERVAL_MINUTES = 5;

export const ScheduleTriggerSchema = z.object({
  kind: z.literal("schedule"),
  /** node-cron expression (5-field). */
  cron: z.string().min(1),
  /** UI convenience label for the preset that produced `cron` (cron stays the source of truth). */
  preset: z.enum(["hourly", "daily", "weekly", "weekday-mornings"]).optional(),
});

export const GithubTriggerEventSchema = z.enum([
  "new-pr",
  "review-requested",
  "ci-failed",
]);

/**
 * A CI/code host to watch. The vendor is a FIELD, not the kind.
 *
 * `host` is deliberately an unconstrained string here — no enum, no union, so
 * adding GitLab or a self-hosted Jenkins never touches this file. What a host
 * MEANS is decided by `pipeline-hosts.ts`: if nothing there can poll it, the
 * create is refused with the registered list, because an automation that can
 * never fire is worse than one that is refused.
 *
 * Replaces `kind: "github"`, which made one vendor into a schema branch, a
 * poller call and a form tab.
 */
export const PipelineTriggerSchema = z.object({
  kind: z.literal("pipeline"),
  /** e.g. "github". Free-form; validated against the poller registry. */
  host: z.string().min(1),
  /** What to watch — shape depends on the host ("owner/name" for GitHub). */
  repo: z.string().min(1),
  events: z.array(GithubTriggerEventSchema).min(1),
  intervalMinutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES),
});

/**
 * The pre-v14.27.0 shape, kept ONLY so saved automations still parse.
 *
 * Migration 0072 rewrites stored rows to `pipeline`; this alias covers anything
 * that slipped through (an in-flight edit, a hand-written file) and is
 * normalised by `parseTrigger` rather than reaching the runner.
 */
export const LegacyGithubTriggerSchema = z.object({
  kind: z.literal("github"),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  events: z.array(GithubTriggerEventSchema).min(1),
  intervalMinutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES),
});

export const McpTriggerSchema = z.object({
  kind: z.literal("mcp"),
  serverId: z.number().int(),
  tool: z.string().min(1),
  /** Arguments passed verbatim to the MCP tool on every poll. */
  args: z.unknown().optional(),
  intervalMinutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES),
});

const RawAutomationTriggerSchema = z.discriminatedUnion("kind", [
  ScheduleTriggerSchema,
  PipelineTriggerSchema,
  LegacyGithubTriggerSchema,
  McpTriggerSchema,
]);

/**
 * Accepts the legacy `github` shape and hands back a `pipeline`, so exactly one
 * shape reaches the runner, the form and the tool.
 */
export const AutomationTriggerSchema = RawAutomationTriggerSchema.transform(
  (t) =>
    t.kind === "github"
      ? ({
          kind: "pipeline" as const,
          host: "github",
          repo: t.repo,
          events: t.events,
          intervalMinutes: t.intervalMinutes,
        })
      : t,
);

export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;
export type PipelineTrigger = z.infer<typeof PipelineTriggerSchema>;
/** Legacy alias — the GitHub poller still speaks this shape. */
export type GithubTrigger = z.infer<typeof LegacyGithubTriggerSchema>;
export type McpTrigger = z.infer<typeof McpTriggerSchema>;
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

/**
 * notify-only (the DEFAULT): a fired trigger posts its context to the feed +
 * notification with ZERO model involvement — the user decides per event
 * whether to present it to the model ("Send to chat"). The agent-run modes
 * are explicit per-automation opt-ins; nothing spends tokens unless chosen.
 */
export const AutomationRunModeSchema = z.enum(["notify-only", "read-only"]);
export type AutomationRunMode = z.infer<typeof AutomationRunModeSchema>;

/** IPC create/update payload (id/workspaceId handled by the handler). */
export const AutomationInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    enabled: z.boolean().default(true),
    trigger: AutomationTriggerSchema,
    /** Required for agent-run modes; notify-only automations don't need one. */
    prompt: z.string().default(""),
    runMode: AutomationRunModeSchema.default("notify-only"),
    /**
     * Does a finished run reach the AGENT, or only the user?
     *
     * REQUIRED, with no default, and that is the design rather than an
     * oversight: this is the field that decides whether an automation can spend
     * tokens in chat, and a default would make that decision silently on behalf
     * of whoever created it. Both the user (Automations tab) and the agent
     * (`automations` tool) have to say which they mean — and either can flip it
     * afterwards, so choosing is cheap and reversible rather than a commitment.
     *
     *   true  → the outcome lands in the agent's next turn (CI, tests).
     *   false → run feed + OS notification only; the agent is never woken, so
     *           the automation cannot cost tokens (Slack/MCP inbox noise).
     */
    notifyAgent: z.boolean(),
    /** {provider,name} override; null → settings.selectedModel at run time. */
    model: z.object({ provider: z.string(), name: z.string() }).nullable().default(null),
  })
  .refine((v) => v.runMode === "notify-only" || v.prompt.trim().length > 0, {
    message: "Agent-run automations need a prompt",
    path: ["prompt"],
  });
export type AutomationInput = z.infer<typeof AutomationInputSchema>;

export type GithubCursor = {
  lastPrNumber?: number;
  seenReviewIds?: number[];
  lastWorkflowRunId?: number;
};

export type McpCursor = { hash: string };

export type AutomationRunStatus = "running" | "ok" | "nothing-to-report" | "error";

/** Renderer-facing run row (broadcast on automation:run-update and returned by automations:runs). */
export interface AutomationRunView {
  id: string;
  automationId: string;
  automationName: string;
  sessionId: string | null;
  status: AutomationRunStatus;
  summary: string | null;
  error: string | null;
  unread: boolean;
  archived: boolean;
  /** Fired-trigger context (notify-only runs) — fuels the "Send to chat" chip. */
  triggerContext: string | null;
  startedAt: number;
  finishedAt: number | null;
}
