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

export const GithubTriggerSchema = z.object({
  kind: z.literal("github"),
  /** "owner/name" — prefilled from the workspace origin remote at creation. */
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

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  ScheduleTriggerSchema,
  GithubTriggerSchema,
  McpTriggerSchema,
]);

export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;
export type GithubTrigger = z.infer<typeof GithubTriggerSchema>;
export type McpTrigger = z.infer<typeof McpTriggerSchema>;
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationRunModeSchema = z.enum(["read-only", "worktree-write"]);
export type AutomationRunMode = z.infer<typeof AutomationRunModeSchema>;

/** IPC create/update payload (id/workspaceId handled by the handler). */
export const AutomationInputSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: AutomationTriggerSchema,
  prompt: z.string().min(1),
  runMode: AutomationRunModeSchema.default("read-only"),
  /** {provider,name} override; null → settings.selectedModel at run time. */
  model: z.object({ provider: z.string(), name: z.string() }).nullable().default(null),
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
  hasProposal: boolean;
  proposalFiles: string[];
  proposalApplied: boolean;
  startedAt: number;
  finishedAt: number | null;
}
