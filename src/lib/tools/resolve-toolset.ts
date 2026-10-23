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
import { browserInspectWithoutScreenshot } from "./browser-screenshot-text";
import { getPinnedCoreToken } from "@/lib/core/pinned-token";
import {
  includeToolForSession,
  type ModeRegistryKey,
} from "./mode-tool-registry";
import { isCoreTool, isWorkspaceIntegrationTool } from "./ToolManifest";
import { computerLane } from "@/lib/computer/lane";
import {
  getCapabilityProfile,
  type ModelCapabilityProfile,
} from "@/lib/routing/model-capability-profile";

/** Plan workMode routes through the ask tier but needs the plan tool. */
const PLAN_WRITE_TOOLS = ["plan"] as const;

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
  /**
   * Automation runs: no human responder and no visible UI, but the full app
   * infra (MCP servers, web search) exists — a lighter drop-set than headless.
   */
  unattended?: boolean;
}

export interface ResolvedToolset {
  /** Final include list — metadata order preserved. */
  tools: ToolMetadata[];
  capabilityProfile: ModelCapabilityProfile;
  /** workMode + trim gate for attaching the delegation tools. */
  delegationAllowed: boolean;
  /** Pre-trim count (for the branch's [capability] log). */
  preTrimCount: number;
}

export function resolveToolsetForSession(
  input: ResolveToolsetInput,
): ResolvedToolset {
  const { branch, effectiveWorkMode, hasWorkspace, model } = input;

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

  // Stage 2 — mode allowlist. Every allowlisted tool's NAME and SCHEMA bind
  // upfront; v14.34's per-mode reveal tiers only the DESCRIPTIONS downstream
  // (tool-reveal.ts), so nothing here is ever withheld from the model.
  const allNames = new Set(candidates.map((t) => t.name));
  const modeFiltered =
    branch === "ask"
      ? candidates.filter((t) =>
          includeToolForSession(t, {
            // `loaded` is EVERY candidate, deliberately — this stage withholds
            // nothing. It is the seam the old ToolSessionLoader used to narrow
            // the set to core+first-called tools; v14.34's reveal tiers
            // descriptions instead of withholding tools, because the tool
            // definitions sit inside the first prompt-cache breakpoint and
            // growing them mid-session would invalidate the whole prefix.
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
    // Every operation needs an approval card, and headless has no surface to
    // show one on — offering it would only ever end in a blocked turn.
    "manage_mcp_server",
    "web_search",
    "read_url",
    "read_attachment",
    "list_attachments",
    // No other sessions run beside a headless container.
    "list_sessions",
    "send_message",
  ]);
  /**
   * DRIVES A UI SURFACE THE RUN DOES NOT HAVE — dropped headless AND unattended.
   *
   * This used to be a `startsWith("browser_")` test, which was correct while
   * every browser tool carried the prefix. v14.41 consolidated six into
   * `browser_inspect` + **`browser`**, and `"browser".startsWith("browser_")`
   * is FALSE — so the act tool silently survived both filters and was offered
   * to headless benchmark runs with no window and to unattended automations
   * nobody is watching. A prefix test is only as stable as the naming
   * convention it assumes; this names the tools.
   */
  const DRIVES_A_VIEW = (name: string) =>
    name === "browser" || name.startsWith("browser_") || name === "computer";
  // Unattended (automation) runs happen inside the real app — MCP servers,
  // web search, attachments all exist — so only human-handoff and UI-view
  // tools are dropped: ask_user would park the turn forever (no responder),
  // and browser/browser_* drive the user's browser with nobody watching. read_url is
  // also dropped — an arbitrary-host fetch is a data-exfil channel for
  // prompt-injected unattended runs, with little unattended value (web_search
  // routes through the configured aggregator and keeps triage utility).
  const UNATTENDED_DROP = new Set(["ask_user", "read_url"]);
  // A cloud run (headless with a job-scoped Core token) DOES have search: the
  // paid search on the Atlarix proxy (lib/search/paid-search.ts), billed to the
  // job. Benchmark and other headless runs without one still drop the web tools.
  const headlessHasPaidSearch = getPinnedCoreToken() != null;
  const afterHeadless =
    process.env.ATLARIX_HEADLESS === "1"
      ? modeFiltered.filter(
          (t) =>
            !DRIVES_A_VIEW(t.name) &&
            !(
              HEADLESS_DROP.has(t.name) &&
              !(
                headlessHasPaidSearch &&
                (t.name === "web_search" || t.name === "read_url")
              )
            ),
        )
      : modeFiltered;
  const afterUnattended = input.unattended
    ? afterHeadless.filter(
        (t) => !DRIVES_A_VIEW(t.name) && !UNATTENDED_DROP.has(t.name),
      )
    : afterHeadless;
  // Image tools only for a model whose tool results can carry the image. Any
  // other gets "this model cannot view images" back from a screenshot or an
  // image file: a paid round trip for nothing, so they are not offered.
  const imageGated = capabilityProfile.supportsToolMedia
    ? afterUnattended
    : afterUnattended
        .filter((t) => t.name !== "view_image")
        .map((t) =>
          t.name === "browser_inspect" ? browserInspectWithoutScreenshot(t) : t,
        );
  // Computer use exists only for a model the user switched it on for, and
  // only if that model can see the screenshots (lib/computer/lane.ts).
  const tools = imageGated.filter(
    (t) => t.name !== "computer" || computerLane(model) != null,
  );

  // Sub-agent (`task`) surface: available in EVERY mode (v13 — parallel
  // read-only scouts help build/debug too, matching Claude Code's Task tool).
  // Still off on weak (maxTools-capped) profiles (a weak model orchestrating
  // sub-agents of itself is the 1.6 failure mode).
  const delegationAllowed = capabilityProfile.maxTools == null;

  return {
    tools,
    capabilityProfile,
    delegationAllowed,
    preTrimCount: modeFiltered.length,
  };
}
