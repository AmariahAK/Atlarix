/**
 * v12 S19 (closes 3.10) — the ONE toolset-resolution function.
 *
 * The documented 4-stage pipeline (registry metadata → mode allowlist →
 * session loader → capability trim; see mode-tool-registry.ts header) used to
 * be assembled twice in chat_stream_handlers — once per branch, with subtly
 * duplicated profile lookups and filters. Both assembly sites now call THIS.
 *
 * Branch differences are intentional, not drift:
 *  - ask:   starts from `getToolsForAskMode()` (read-only surface), unions the
 *           plan-write tools for workMode "plan" (the session-4 defect fix),
 *           and applies the full `includeToolForSession` mode filter.
 *  - build: starts from `getToolsForContext(hasWorkspace)` and filters only by
 *           session-loader/core/workspace-integration (build offers its whole
 *           context surface; mode gating happens at execute time).
 *
 * Shared tail (both branches): user-agent `tools:` allowlist intersection
 * (v12 7A) → capability trim (v12 2.1, resolves 1.6) → the delegation-surface
 * decision (off on trimmed profiles; off when the user agent excludes it).
 * Output order preserves the input metadata order (manifest rendering stable).
 */

import log from "electron-log";
import { ToolRegistry, type ToolMetadata } from "./registry";
import {
  getModeToolAllowlist,
  includeToolForSession,
  type ModeRegistryKey,
} from "./mode-tool-registry";
import {
  isCoreTool,
  isWorkspaceIntegrationTool,
  WORKSPACE_INTEGRATION_TOOL_NAMES,
} from "./ToolManifest";
import type { ToolSessionLoader } from "./ToolSessionLoader";
import {
  getCapabilityProfile,
  trimToolsForCapability,
  type ModelCapabilityProfile,
} from "@/lib/routing/model-capability-profile";
import { isDelegationAllowedForWorkMode } from "@/lib/agents/agent-runtime";

const logger = log.scope("resolve-toolset");

/** Plan workMode routes through the ask tier but needs the plan-write tools. */
const PLAN_WRITE_TOOLS = [
  "write_implementation_plan",
  "update_plan_status",
  "update_plan_step",
] as const;

const DELEGATION_TOOL_NAMES = [
  "delegate_to_agent",
  "spawn_sub_agent",
  "task",
] as const;

export interface ResolveToolsetInput {
  branch: "ask" | "build";
  effectiveWorkMode: ModeRegistryKey;
  hasWorkspace: boolean;
  /** hasWorkspace && effectiveAppId != null — gates the integration tools. */
  workspaceIntegrationEligible: boolean;
  loader: ToolSessionLoader;
  model: {
    name?: string;
    provider?: string;
    builtinProviderId?: string;
  };
  /** v12 7A: the active user agent's `tools:` allowlist (null/undefined = all). */
  userAgentTools?: readonly string[] | null;
}

export interface ResolvedToolset {
  /** Final include list — metadata order preserved. */
  tools: ToolMetadata[];
  capabilityProfile: ModelCapabilityProfile;
  /** workMode + trim + user-agent gate for attaching the delegation tools. */
  delegationAllowed: boolean;
  /** Pre-trim count (for the branch's [capability] log). */
  preTrimCount: number;
}

export function resolveToolsetForSession(
  input: ResolveToolsetInput,
): ResolvedToolset {
  const {
    branch,
    effectiveWorkMode,
    hasWorkspace,
    workspaceIntegrationEligible,
    loader,
    model,
    userAgentTools,
  } = input;

  // Stage 1 — registry metadata (branch-specific starting surface).
  let candidates: ToolMetadata[];
  if (branch === "ask") {
    candidates = ToolRegistry.getToolsForAskMode();
    // Plan-write union: isReadOnly:false + allowInAskMode:false drops them
    // from the ask surface even though PLAN_ALLOWLIST names them and the ask
    // wrapper has dedicated artifact handling. includeToolForSession's mode
    // filter keeps them plan-only. (v12 0.1 close-out — was a pinned defect.)
    if (effectiveWorkMode === "plan") {
      const offered = new Set(candidates.map((t) => t.name));
      for (const name of PLAN_WRITE_TOOLS) {
        const meta = ToolRegistry.get(name);
        if (meta && !offered.has(name)) candidates.push(meta);
      }
    }
  } else {
    candidates = ToolRegistry.getToolsForContext(hasWorkspace);
  }

  // Stage 3 setup — session loader reveal (branch-specific seed).
  if (branch === "ask") {
    const modeAllowNames = getModeToolAllowlist(effectiveWorkMode);
    loader.ensureLoaded([
      ...modeAllowNames.filter((n) => n !== "*"),
      ...(workspaceIntegrationEligible ? WORKSPACE_INTEGRATION_TOOL_NAMES : []),
    ]);
  } else if (workspaceIntegrationEligible) {
    loader.ensureLoaded(WORKSPACE_INTEGRATION_TOOL_NAMES);
  }
  const loadedNames = loader.getLoadedToolNames();

  // Stages 2+3 — mode allowlist + loader filter.
  const modeFiltered =
    branch === "ask"
      ? candidates.filter((t) =>
          includeToolForSession(t, {
            loaded: loadedNames,
            hasWorkspace,
            mode: effectiveWorkMode,
            isCore: isCoreTool,
          }),
        )
      : candidates.filter(
          (t) =>
            loadedNames.has(t.name) ||
            isCoreTool(t) ||
            (hasWorkspace && isWorkspaceIntegrationTool(t.name)),
        );

  // v12 7A — user-agent allowlist intersection (composes with the trim).
  const preTrim = userAgentTools
    ? modeFiltered.filter((t) => userAgentTools.includes(t.name))
    : modeFiltered;

  // Stage 4 — capability trim (v12 2.1; resolves 1.6).
  const capabilityProfile = getCapabilityProfile({
    name: model.name ?? "",
    provider: model.provider,
    builtinProviderId: model.builtinProviderId,
  });
  const tools = trimToolsForCapability(preTrim, capabilityProfile, isCoreTool);
  if (tools.length < preTrim.length) {
    logger.log(
      `[capability] ${branch === "ask" ? "Ask" : "Build"} toolset trimmed ${preTrim.length}→${tools.length} for ${model.name}`,
    );
  }

  // Delegation surface: off on trimmed profiles (a weak model orchestrating
  // sub-agents of itself is the 1.6 failure mode; the schemas are the
  // heaviest on offer) and off when a user agent's allowlist excludes it.
  const agentAllowsDelegation =
    !userAgentTools ||
    userAgentTools.some((t) =>
      (DELEGATION_TOOL_NAMES as readonly string[]).includes(t),
    );
  const delegationAllowed =
    isDelegationAllowedForWorkMode(effectiveWorkMode) &&
    capabilityProfile.maxTools == null &&
    agentAllowsDelegation;

  return {
    tools,
    capabilityProfile,
    delegationAllowed,
    preTrimCount: preTrim.length,
  };
}
