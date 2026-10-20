/**
 * The FIXED per-turn prompt prefix, measured the way it dispatches.
 *
 * WHY THIS EXISTS
 * ---------------
 * The context meter used to report the system prompt alone. Measured on
 * v14.40.0 with the real tokenizer, ON THE WIRE, the fixed prefix in Build mode
 * was 15,329 tokens and the meter said ~4,000: the tool surface — 4,183 tokens
 * of descriptions and 5,747 of parameter JSON schemas — was billed on every turn
 * and counted by nothing. So ~74% of the prefix was invisible, on the one
 * instrument anyone would use to judge whether a prompt change helped.
 *
 * (A bare `constructSystemPromptParts` measurement of the same mode comes out
 * ~1,100 lower, because a real dispatch also carries the mode reanchor and the
 * ContextAssembler's pointers. Hence "on the wire" — the per-mode baselines and
 * ceilings live in tests/agent-evals/prompt-budget.eval.test.ts, which reads the
 * dispatched request rather than calling any builder.)
 *
 * THE RULE THIS FOLLOWS
 * ---------------------
 * Measure what DISPATCHES, not what was constructed. That means going through
 * `resolveToolsetForSession` — the single documented assembly point both stream
 * branches call — rather than re-deriving a tool list here. A second derivation
 * is exactly how the meter came to disagree with the dispatch in the first
 * place (it hand-rolled work-mode resolution and could land on the legacy
 * all-five-modes prompt, a shape no stream has ever sent).
 *
 * TWO THINGS THE SUM MUST MODEL, both learned by reading the branches:
 *
 *  - **`task` is bound AFTER assembly, verbatim.** `attachDelegationToolsToSet`
 *    overwrites `tools.task` with the registry's raw description and raw
 *    parameters — it does not go through `describeToolForMode` or
 *    `simplifyToolParametersForProfile`. Harmless today (`task` is core in
 *    every mode, so tiering is a no-op for it) but it is what actually ships,
 *    and the existing `[tool-reveal]` log measures the pre-attach list instead.
 *  - **MCP tools are not part of the prefix.** They are deliberately not
 *    pre-merged; the model reaches them through `list_available_mcps` +
 *    `mcp_call`. So the prefix is static per (mode, model, hasWorkspace), which
 *    is also what makes it cacheable.
 *
 * ON PRECISION
 * ------------
 * Descriptions are exact — they are the strings that ship. Schemas are measured
 * as `JSON.stringify` of the object handed to the AI SDK, which is within a few
 * percent of the wire: each provider re-serialises schemas its own way (added
 * `additionalProperties`, reordered keys, JSON-Schema dialect differences), so
 * matching one provider byte-for-byte would be false precision and wrong for
 * the others. This is a budget, not an invoice.
 */

/**
 * LOAD-BEARING SIDE-EFFECT IMPORT — do not "clean this up".
 *
 * Tools register themselves when `lib/tools/index` is imported; nothing calls an
 * `initializeTools()` at startup (its log line never appears in a packaged boot).
 * `resolve-toolset` imports `ToolRegistry` from `./registry` directly, so it does
 * NOT pull the index in — meaning this module could run against an EMPTY
 * registry and return a surface of zero tokens without throwing.
 *
 * That is exactly the silent-zero this file exists to prevent, and it was
 * briefly real: the import was originally here, then removed alongside an unused
 * helper that a dead-code report flagged. `prompt-budget-registry.test.ts`
 * deliberately does not import the index, so it fails if this line goes again.
 */
import "@/lib/tools";
import { resolveToolsetForSession } from "@/lib/tools/resolve-toolset";
import { describeToolForMode } from "@/lib/tools/tool-reveal";
import { simplifyToolParametersForProfile } from "@/lib/routing/model-capability-profile";
import { isReadOnlyWorkMode } from "@/lib/work-mode";
import type { WorkMode } from "@/lib/schemas";
import { exactTokenCountText } from "./token-counter";

/** The name the delegation attach re-binds after the toolset loop. */
const DELEGATION_TOOL_NAME = "task";

export type ToolSurfaceBudget = {
  /** Tools whose name + schema bind this turn. */
  toolCount: number;
  /** Bound descriptions, after per-mode reveal tiering. */
  descriptionTokens: number;
  /** Parameter JSON schemas, after the weak-model simplification stage. */
  schemaTokens: number;
  /** `descriptionTokens + schemaTokens` — the whole tool half of the prefix. */
  total: number;
};

export type MeasureToolSurfaceInput = {
  workMode: WorkMode;
  hasWorkspace: boolean;
  workspaceIntegrationEligible: boolean;
  model: {
    name?: string;
    provider?: string;
    builtinProviderId?: string;
  };
  unattended?: boolean;
};

/**
 * Measure the tool half of the dispatched prefix for one (mode, model) pair.
 *
 * The branch is derived with `isReadOnlyWorkMode` — the same predicate
 * `chat_stream_handlers` uses to pick a turn runner — so Explore/Plan/Review
 * measure the ask surface and Build/Debug measure the build surface, without a
 * second rule that can drift from it.
 */
export function measureToolSurface(
  input: MeasureToolSurfaceInput,
): ToolSurfaceBudget {
  const branch: "ask" | "build" = isReadOnlyWorkMode(input.workMode)
    ? "ask"
    : "build";

  const resolved = resolveToolsetForSession({
    branch,
    effectiveWorkMode: input.workMode,
    hasWorkspace: input.hasWorkspace,
    workspaceIntegrationEligible: input.workspaceIntegrationEligible,
    model: input.model,
    unattended: input.unattended,
  });

  /**
   * An empty surface is never a legitimate answer — every mode binds at least
   * the every-mode tools — so it means the registry was not populated. Throwing
   * makes that LOUD: the caller catches it and logs "reporting system prompt
   * only", which is a visible degradation rather than a meter that quietly
   * under-reports by thousands of tokens and looks like a win.
   */
  if (resolved.tools.length === 0) {
    throw new Error(
      `No tools resolved for mode "${input.workMode}" — the ToolRegistry is ` +
        `empty, which means lib/tools/index was never imported. See the ` +
        `side-effect import at the top of this file.`,
    );
  }

  let descriptionTokens = 0;
  let schemaTokens = 0;

  for (const tool of resolved.tools) {
    // `task`, when delegation is on, is re-bound verbatim after this loop runs
    // in the real branches — so measure it that way rather than as the loop
    // would have left it.
    const boundVerbatim =
      tool.name === DELEGATION_TOOL_NAME && resolved.delegationAllowed;

    const description = boundVerbatim
      ? tool.description
      : describeToolForMode(tool, input.workMode);

    const parameters = boundVerbatim
      ? (tool.parameters ?? { type: "object", properties: {} })
      : simplifyToolParametersForProfile(
          tool.parameters ?? { type: "object", properties: {} },
          resolved.capabilityProfile,
        );

    descriptionTokens += exactTokenCountText(description ?? "");
    schemaTokens += exactTokenCountText(safeStringify(parameters));
  }

  return {
    toolCount: resolved.tools.length,
    descriptionTokens,
    schemaTokens,
    total: descriptionTokens + schemaTokens,
  };
}

/**
 * A tool schema that cannot be serialised must not take the meter down with it
 * — the meter is an estimate, and a wrong estimate beats a thrown IPC. Returns
 * "" so the tool contributes 0 rather than a fabricated number.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
