/**
 * Agent runtime — delegation for Explore/Review only; permissions always manual.
 */

import type { UserSettings, WorkMode } from "@/lib/schemas";
import type { DelegateArgs } from "@/lib/tools/agent";

export const MAX_SUBAGENTS_PER_TURN = 5;

export type DelegationConfig = {
  maxDelegationDepth: number;
  maxDelegationsPerTurn: number;
  maxConcurrentDelegations: number;
  tokenBudgetPerTurn?: number;
  enableParallelPrefetch: boolean;
};

export function isDelegationAllowedForWorkMode(workMode: WorkMode): boolean {
  return workMode === "ask" || workMode === "review";
}

export function getDelegationConfig(settings: UserSettings): DelegationConfig {
  const delegation = settings.aiConfiguration?.delegation;
  const legacyAuto = settings.aiConfiguration?.autonomous;
  const legacyGuided = settings.aiConfiguration?.guided;
  return {
    maxDelegationDepth:
      delegation?.maxDelegationDepth ??
      legacyAuto?.maxDelegationDepth ??
      2,
    maxDelegationsPerTurn:
      delegation?.maxDelegationsPerTurn ??
      legacyAuto?.maxDelegationsPerTurn ??
      legacyGuided?.maxDelegationsPerTurn ??
      MAX_SUBAGENTS_PER_TURN,
    maxConcurrentDelegations:
      delegation?.maxConcurrentDelegations ?? MAX_SUBAGENTS_PER_TURN,
    tokenBudgetPerTurn:
      delegation?.tokenBudgetPerTurn ?? legacyAuto?.tokenBudgetPerTurn,
    enableParallelPrefetch:
      delegation?.enableParallelPrefetch ?? false,
  };
}

/** Tool permissions always require user approval (former Guided behavior). */
export function shouldAutoApprovePermissions(
  _agentMode?: string | undefined,
  _chatId?: number | null | undefined,
): boolean {
  return false;
}

export function delegationChatModeFromWorkMode(
  workMode: WorkMode,
): NonNullable<DelegateArgs["delegationChatMode"]> {
  if (workMode === "plan") return "plan";
  if (workMode === "build" || workMode === "debug") return "build";
  return "ask";
}

/** Tool names always registered when workspace stream runs. */
export const DELEGATION_TOOL_NAMES = [
  "delegate_to_agent",
  "spawn_sub_agent",
  "task",
] as const;

