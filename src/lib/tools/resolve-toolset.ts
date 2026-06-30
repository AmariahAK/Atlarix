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

import { ToolRegistry, type ToolMetadata } from "./registry";
import {
  includeToolForSession,
  type ModeRegistryKey,
} from "./mode-tool-registry";
import { isCoreTool, isWorkspaceIntegrationTool } from "./ToolManifest";
import {
  getCapabilityProfile,
  type ModelCapabilityProfile,
} from "@/lib/routing/model-capability-profile";

/** Plan workMode routes through the ask tier but needs the plan tool. */
const PLAN_WRITE_TOOLS = ["plan"] as const;

const DELEGATION_TOOL_NAMES = ["task"] as const;

export interface ResolveToolsetInput {
  branch: "ask" | "build";
  effectiveWorkMode: ModeRegistryKey;
  hasWorkspace: boolean;
  /** hasWorkspace && effectiveAppId != null — gates the integration tools. */
  workspaceIntegrationEligible: boolean;
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

  // Stage 2 — mode allowlist. v13: progressive reveal is GONE — the surface is
  // ~22 tools, so every allowlisted tool's schema binds upfront.
  const allNames = new Set(candidates.map((t) => t.name));
  const modeFiltered =
    branch === "ask"
      ? candidates.filter((t) =>
          includeToolForSession(t, {
            loaded: allNames,
            hasWorkspace,
            mode: effectiveWorkMode,
            isCore: isCoreTool,
          }),
        )
      : candidates.filter(
          (t) =>
            allNames.has(t.name) ||
            isCoreTool(t) ||
            (hasWorkspace && isWorkspaceIntegrationTool(t.name)),
        );

  // v12 7A — user-agent allowlist intersection (composes with the trim).
  const preTrim = userAgentTools
    ? modeFiltered.filter((t) => userAgentTools.includes(t.name))
    : modeFiltered;

  // v13: the capability TRIM stage (tool-count cap) is gone — at ~22 tools the
  // surface is already minimal, so every model gets the full mode allowlist.
  // The capability PROFILE is still resolved for parameter-schema simplification
  // and the delegation gate below.
  const capabilityProfile = getCapabilityProfile({
    name: model.name ?? "",
    provider: model.provider,
    builtinProviderId: model.builtinProviderId,
  });
  // Headless (Electron-free, autonomous) runs drop tools that can't work or are
  // actively harmful with no human/UI in the loop. Electron app path unaffected:
  //  - browser_*: no WebContentsView to drive (always fail).
  //  - ask_user: there is NO responder headless — calling it ENDS the turn and
  //    the process exits "completed" WITHOUT finishing the task (a silent
  //    false-success). An autonomous agent must never hand control to a human.
  //  - mcp_call / list_available_mcps: no MCP servers are configured in a
  //    headless container, so they only waste schema slots + turns.
  //  - web_search / read_url: no search infra in autonomous containers; the
  //    model otherwise burns turns on web tools that can't help. (read_attachment
  //    / list_attachments are dead weight too — no attachments headless.)
  // KEPT headless: plan (feeds the task-ledger/completion logic), task
  // (parallel scouts can help on hard tasks), compress_context.
  const HEADLESS_DROP = new Set([
    "ask_user",
    "mcp_call",
    "list_available_mcps",
    "web_search",
    "read_url",
    "read_attachment",
    "list_attachments",
    // preview_test drives the preview WebContentsView (like browser_*, but
    // doesn't share the prefix) — no such view exists in the Electron-free CLI.
    "preview_test",
  ]);
  const tools =
    process.env.ATLARIX_HEADLESS === "1"
      ? preTrim.filter(
          (t) => !t.name.startsWith("browser_") && !HEADLESS_DROP.has(t.name),
        )
      : preTrim;

  // Sub-agent (`task`) surface: available in EVERY mode (v13 — parallel
  // read-only scouts help build/debug too, matching Claude Code's Task tool).
  // Still off on weak (maxTools-capped) profiles (a weak model orchestrating
  // sub-agents of itself is the 1.6 failure mode) and when a user agent's
  // allowlist excludes it.
  const agentAllowsDelegation =
    !userAgentTools ||
    userAgentTools.some((t) =>
      (DELEGATION_TOOL_NAMES as readonly string[]).includes(t),
    );
  const delegationAllowed =
    capabilityProfile.maxTools == null && agentAllowsDelegation;

  return {
    tools,
    capabilityProfile,
    delegationAllowed,
    preTrimCount: preTrim.length,
  };
}
