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

/**
 * RETIRED: `PipelineTriggerSchema` and `LegacyGithubTriggerSchema`.
 *
 * A pipeline trigger watched a CI/code host, and its only registered host was
 * GitHub. That is the same hardcoding as the deleted clone flow: polling for a
 * new PR, a mention or a finished job is an API problem, identical for GitHub,
 * GitLab and Bitbucket, and a bespoke poller for one vendor could never serve
 * the other two.
 *
 * WHY THE SHAPE HAD TO GO, NOT JUST THE HOST. With the host unregistered but
 * the schema branch kept, a `pipeline` trigger would still SAVE cleanly and
 * then never fire — and "never fired" is indistinguishable from "nothing
 * happened yet", forever. the deleted `pipeline-hosts.test.ts` was written to warn
 * about exactly that shape, so leaving the branch would have shipped the very
 * thing that test existed to prevent.
 *
 * The host-agnostic replacement already exists: an **MCP trigger** polls any
 * API (an MCP server can speak to all three hosts), and a **schedule** trigger
 * plus `run_command` covers the rest.
 *
 * Stored rows of the retired kinds no longer parse. `runner.ts` does NOT let
 * that pass quietly — `retireUnparseableAutomation` disables the automation and
 * records the reason in the run feed, because an automation left enabled and
 * unable to fire IS the failure above.
 */

export const McpTriggerSchema = z.object({
  kind: z.literal("mcp"),
  /** A server on this computer, for the folder (its row id). */
  serverId: z.number().int().optional(),
  /**
   * Or a web server on the account, by name: the same one in the app, the CLI
   * and editors. Exactly one of the two is set (checked where it is saved).
   */
  accountServer: z.string().min(1).max(60).optional(),
  tool: z.string().min(1),
  /** Arguments passed verbatim to the MCP tool on every poll. */
  args: z.unknown().optional(),
  intervalMinutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES),
});

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  ScheduleTriggerSchema,
  McpTriggerSchema,
]);

export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;
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
    model: z
      .object({ provider: z.string(), name: z.string() })
      .nullable()
      .default(null),
  })
  .refine((v) => v.runMode === "notify-only" || v.prompt.trim().length > 0, {
    message: "Agent-run automations need a prompt",
    path: ["prompt"],
  });
export type AutomationInput = z.infer<typeof AutomationInputSchema>;

export type McpCursor = { hash: string };

export type AutomationRunStatus =
  | "running"
  | "ok"
  | "nothing-to-report"
  | "error";

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

/**
 * One string for "which MCP server": `local:<id>` or `account:<name>`, for
 * pickers on every surface. Empty when the trigger names neither.
 */
export function mcpTriggerRef(t: Pick<McpTrigger, "serverId" | "accountServer">): string {
  if (t.accountServer) return `account:${t.accountServer}`;
  return t.serverId != null ? `local:${t.serverId}` : "";
}

/** The trigger's server fields from a picker's ref. */
export function mcpTriggerServerFromRef(ref: string): Pick<McpTrigger, "serverId" | "accountServer"> {
  if (ref.startsWith("account:")) return { accountServer: ref.slice("account:".length) };
  const id = Number(ref.startsWith("local:") ? ref.slice("local:".length) : ref);
  return Number.isInteger(id) ? { serverId: id } : {};
}

/** Throws a sentence when an MCP trigger names no server, or both kinds. */
export function assertMcpTriggerServer(t: McpTrigger): void {
  const n = Number(t.serverId != null) + Number(!!t.accountServer);
  if (n !== 1) throw new Error("An MCP trigger needs one server: serverId (this computer) or accountServer (your account).");
}
