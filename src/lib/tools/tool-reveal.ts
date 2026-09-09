/**
 * Per-mode progressive tool reveal (v14.34).
 *
 * WHAT THIS IS
 * ------------
 * Every mode still BINDS its whole allowlist — names and schemas — but only its
 * workhorses carry a full description. Everything else is bound with one line
 * plus a pointer to `tool_help`, which returns the full text as a tool RESULT.
 *
 * WHY IT IS SHAPED THIS WAY
 * -------------------------
 * v13 deleted the old progressive reveal (`ToolSessionLoader`, core-preloaded +
 * others on first call) on the reasoning that a ~22-tool surface is small enough
 * to bind upfront. That reasoning was about tool COUNT, and the cost is not the
 * count — it is the descriptions. Measured on Build's 27-tool surface:
 * ~28,000 chars ≈ 7,000 tokens of static tool descriptions, bound on every turn,
 * with no trimming stage of any kind. `automations` alone is 2,857 chars;
 * `run_command` 2,808; `task` 2,104; `browser_inspect` 2,049.
 *
 * That growth was a consequence of a deliberate, correct decision: mode-prompt-
 * bundle.ts moved guidance OUT of the system prompt and ONTO tool descriptions,
 * reasoning that "descriptions are progressive — they enter context only when
 * the tool is bound". True while reveal existed; a one-way ratchet without it.
 *
 * THE CONSTRAINT THAT PICKED THE DESIGN — PROMPT CACHING
 * -----------------------------------------------------
 * `lib/ai/anthropic-cache-breakpoints.ts` puts the stable system header's cache
 * breakpoint over **tools + system**. Tool definitions live INSIDE the first
 * cache breakpoint, so any change to the tools array invalidates the entire
 * cached prefix and forces a full re-write. A ladder that revealed tools AS A
 * TURN PROGRESSED would blow the cache on every reveal and cost more than the
 * smaller surface saves.
 *
 * So the tiering is per MODE and fixed for the session: one stable cache prefix
 * per mode. `tool_help` delivers the full text through the MESSAGE stream, never
 * by mutating the tools array — the prefix is untouched.
 *
 * Consequences that fall out of that choice, each of which is a bug the
 * reference harnesses have shipped and we get to skip:
 *  - nothing is ever unreachable (name + schema always bound), so there is no
 *    "the model cannot see the tool exists" failure;
 *  - nothing is lost across compaction, because no schema was ever deferred;
 *  - resume cannot miss the cache, because the prefix never depended on which
 *    tools had been revealed so far.
 *
 * TIERING RULE
 * ------------
 * Core = what this mode uses constantly, or what is dangerous to under-explain.
 * Everything else in the mode's surface is peripheral. When unsure, keep it
 * core: a one-line description can DEGRADE tool selection on weak models, which
 * is the opposite of the point. Tools whose descriptions are already
 * pointer-sized (`read_file` 324 chars, `mcp_call` 292) are left core because
 * tiering them saves nothing and only costs clarity.
 */

import type { ToolMetadata } from "./registry";
import type { ModeRegistryKey } from "./mode-tool-registry";
import { firstSentence } from "@/lib/text/first-sentence";

/**
 * Per-mode workhorses. The mode's remaining allowlisted tools are peripheral.
 *
 * These differ by mode on purpose — that is the whole point of doing this per
 * mode rather than once globally. `edit_file`/`run_command` are the job in
 * Build and absent or incidental in Explore; `plan` is the job in Plan and
 * incidental in Build; the browser family is peripheral everywhere until the
 * user is actually driving a page.
 */
const CORE_TOOLS_BY_MODE: Record<ModeRegistryKey, readonly string[]> = {
  // Explore — read, search, run read-only commands, ask, delegate recon.
  ask: [
    "read_file",
    "grep",
    "glob",
    "run_command",
    "web_search",
    "task",
    "ask_user",
    "tool_help",
  ],
  // Plan — same reading surface, plus the artifact it exists to author. No
  // run_command in this mode's allowlist at all.
  plan: [
    "read_file",
    "grep",
    "glob",
    "plan",
    "web_search",
    "task",
    "ask_user",
    "tool_help",
  ],
  // Build — writing and verifying. `background_jobs` stays core because a
  // foreground command auto-promotes to the background after ~15s, so the model
  // needs to understand the mechanism it will hit whether or not it asked for
  // it. `proposals` stays core because accepting one ends in a real write.
  build: [
    "read_file",
    "grep",
    "glob",
    "edit_file",
    "run_command",
    "background_jobs",
    "plan",
    "proposals",
    "task",
    "ask_user",
    "tool_help",
  ],
  // Debug — identical surface to Build; the two differ by prompt discipline.
  debug: [
    "read_file",
    "grep",
    "glob",
    "edit_file",
    "run_command",
    "background_jobs",
    "plan",
    "proposals",
    "task",
    "ask_user",
    "tool_help",
  ],
  // Review — reading and verifying, no writing.
  review: [
    "read_file",
    "grep",
    "glob",
    "run_command",
    "task",
    "ask_user",
    "tool_help",
  ],
};

/** Descriptions at or under this are already pointer-sized — never tier them. */
const ALREADY_SHORT_CHARS = 400;

/**
 * Never trimmed, in any mode, however peripheral or long.
 *
 * A pointer works for "how do I use this". It does NOT work for "do not do the
 * obvious wrong thing", because a model that is about to make the mistake has no
 * idea it needs to go and read more first — it reads the short version, falls
 * into the lure, and `tool_help` is never called.
 *
 * So a description that exists to STEER AWAY from a known failure mode is not
 * documentation, it is a correction, and it has to be in front of the model at
 * decision time. `browser_inspect` is the worked example: v14.8.9 rewrote it to
 * route "what do you see" to a visual read, make screenshots the last resort,
 * and remove a "VISUAL confirmation" lure that had caused an OBSERVED bug. Its
 * first sentence carries none of that, and
 * `tests/agent-evals/capability-trim.eval.test.ts` correctly fails if it is
 * trimmed — which is how this entry came to exist.
 *
 * Add to this list only with that justification: a real failure the wording is
 * there to prevent.
 */
const NEVER_TRIM = new Set(["browser_inspect"]);

export type RevealTier = "core" | "peripheral";

export function revealTierForMode(
  toolName: string,
  description: string,
  mode: ModeRegistryKey,
): RevealTier {
  if (CORE_TOOLS_BY_MODE[mode]?.includes(toolName)) return "core";
  // A correction the model must read BEFORE it decides, not after it asks.
  if (NEVER_TRIM.has(toolName)) return "core";
  // Nothing to win, and a needless indirection for the model.
  if (description.length <= ALREADY_SHORT_CHARS) return "core";
  return "peripheral";
}

/**
 * The description to BIND for this tool in this mode.
 *
 * Core → verbatim. Peripheral → one sentence plus the pointer, so the model can
 * still tell what the tool is for and knows exactly how to get the rest.
 */
export function describeToolForMode(
  tool: Pick<ToolMetadata, "name" | "description">,
  mode: ModeRegistryKey,
): string {
  const tier = revealTierForMode(tool.name, tool.description, mode);
  if (tier === "core") return tool.description;
  return (
    `${firstSentence(tool.description)} ` +
    `Full usage: tool_help({tool:"${tool.name}"}) — read it BEFORE your first ${tool.name} call in this session.`
  );
}

/**
 * The parameter SCHEMA to bind for this tool in this mode.
 *
 * The half this file was missing. It tiered descriptions from the day it was
 * written, on the reasoning that descriptions were the cost — and they were the
 * cost that had been measured. Measured again on v14.40.0, the parameter schemas
 * are LARGER: 5,747 tokens against 4,183 of descriptions on Build's surface,
 * with no trimming stage of any kind.
 *
 * Same tier decision, same pointer, same cache-safety argument: `tool_help`
 * returns the full text through the MESSAGE stream, so the tools array — which
 * sits inside the first cache breakpoint — is untouched. A peripheral tool keeps
 * every parameter, its type, its enum and its default; only the prose is cut to
 * a first sentence.
 *
 * CORE TOOLS ARE LEFT ALONE, deliberately. `run_command`, `edit_file`, `task`
 * and `read_file` are where a mis-filled parameter costs the most, and the
 * aggressive variant of this (first-sentence everywhere) would have saved ~1,400
 * tokens instead of ~350 by trimming exactly those. That trade was declined:
 * the point of the exercise is a prefix that is smaller AND at least as
 * accurate, and there is no evidence a shorter `edit_file` schema is as good.
 */
export function parametersForMode(
  tool: Pick<ToolMetadata, "name" | "description" | "parameters">,
  mode: ModeRegistryKey,
): unknown {
  const parameters = tool.parameters;
  if (revealTierForMode(tool.name, tool.description, mode) === "core") {
    return parameters;
  }
  return trimParameterProse(parameters);
}

/**
 * Cut every parameter's `description` to its first sentence, without touching
 * anything a call depends on.
 *
 * Returns a NEW object at every level it rewrites — the input is the registry's
 * own singleton, shared across every turn and every mode, so mutating it would
 * tier a tool permanently the first time any mode bound it peripherally.
 *
 * Handles the two `parameters` shapes this codebase actually contains: a proper
 * `{type:"object", properties}` schema, and the "bare property map" some tools
 * hand-write (documented in lib/ai/normalize-tool-schema.ts). An unrecognised
 * shape is returned untouched rather than guessed at.
 */
function trimParameterProse(parameters: unknown): unknown {
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    return parameters;
  }
  const schema = parameters as Record<string, unknown>;
  const props = schema.properties;

  if (props && typeof props === "object" && !Array.isArray(props)) {
    return {
      ...schema,
      properties: trimPropertyMap(props as Record<string, unknown>),
    };
  }

  // Bare property map: no `type`/`properties` wrapper, values are schema nodes.
  if (schema.type === undefined && schema.properties === undefined) {
    return trimPropertyMap(schema);
  }
  return parameters;
}

function trimPropertyMap(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(props)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      out[key] = node;
      continue;
    }
    const n = node as Record<string, unknown>;
    out[key] =
      typeof n.description === "string" && n.description.length > 0
        ? { ...n, description: firstSentence(n.description, PARAM_PROSE_MAX) }
        : n;
  }
  return out;
}

/**
 * Shorter than the 200-char default `firstSentence` uses for a tool
 * description: a parameter's first sentence is normally its whole point ("Which
 * tab to act on"), and the ones that run long do so by appending a second
 * clause after the period, which the sentence split already drops.
 */
const PARAM_PROSE_MAX = 140;

/** Names bound with a trimmed description in this mode (for logging/tests). */
export function peripheralToolNames(
  tools: readonly Pick<ToolMetadata, "name" | "description">[],
  mode: ModeRegistryKey,
): string[] {
  return tools
    .filter(
      (t) => revealTierForMode(t.name, t.description, mode) === "peripheral",
    )
    .map((t) => t.name);
}

/**
 * Chars saved by the tiering this turn — the number worth logging.
 *
 * Counts descriptions AND schemas, because the tiering now covers both. It
 * reported descriptions alone while the schemas were the larger half, which
 * made the log line an understatement of its own effect.
 */
export function revealSavings(
  tools: readonly Pick<ToolMetadata, "name" | "description" | "parameters">[],
  mode: ModeRegistryKey,
): {
  full: number;
  bound: number;
  descFull: number;
  descBound: number;
  schemaFull: number;
  schemaBound: number;
} {
  let descFull = 0;
  let descBound = 0;
  let schemaFull = 0;
  let schemaBound = 0;
  for (const t of tools) {
    descFull += t.description.length;
    descBound += describeToolForMode(t, mode).length;
    schemaFull += schemaChars(t.parameters);
    schemaBound += schemaChars(parametersForMode(t, mode));
  }
  return {
    full: descFull + schemaFull,
    bound: descBound + schemaBound,
    descFull,
    descBound,
    schemaFull,
    schemaBound,
  };
}

function schemaChars(parameters: unknown): number {
  try {
    return JSON.stringify(parameters ?? {})?.length ?? 0;
  } catch {
    return 0;
  }
}
