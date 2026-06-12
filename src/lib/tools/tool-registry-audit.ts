/**
 * Validates ToolRegistry names against per-mode allowlists.
 */

import { ToolRegistry } from "./registry";
import {
  getModeToolAllowlist,
  type ModeRegistryKey,
} from "./mode-tool-registry";

// v13: debug is full-surface like build — only the allowlisted modes count.
const NON_BUILD_MODES: Exclude<ModeRegistryKey, "build" | "debug">[] = [
  "ask",
  "plan",
  "review",
];

/** Chat-scoped tools not listed on a single mode allowlist (available broadly). */
export const GLOBAL_CHAT_TOOLS = new Set([
  "ask_user",
  "compress_context",
  "web_search",
  "read_url",
  "read_attachment",
  "list_attachments",
]);

/**
 * Tools available only in Build/Debug (full surface), not on ask/plan/review allowlists.
 * Update when adding tools; `auditToolRegistry` fails if drift occurs.
 */
export const BUILD_ONLY_TOOLS = [
  "browser_click",
  "browser_fill",
  "edit_file",
  "write_file",
] as const satisfies readonly string[];

const BUILD_ONLY_SET = new Set<string>(BUILD_ONLY_TOOLS);

export function unionNonBuildAllowlist(): Set<string> {
  const s = new Set<string>();
  for (const mode of NON_BUILD_MODES) {
    for (const name of getModeToolAllowlist(mode)) {
      s.add(name);
    }
  }
  return s;
}

export type ToolRegistryAuditResult = {
  allowlistNotRegistered: string[];
  registeredNotAccounted: string[];
  buildOnlyDrift: { missing: string[]; extra: string[] };
};

/** Tools registered but not on any non-build mode allowlist or GLOBAL_CHAT_TOOLS. */
export function getComputedBuildOnlyTools(): string[] {
  const union = unionNonBuildAllowlist();
  return ToolRegistry.getAll()
    .map((t) => t.name)
    .filter((n) => !union.has(n) && !GLOBAL_CHAT_TOOLS.has(n))
    .sort();
}

export function auditToolRegistry(): ToolRegistryAuditResult {
  const registered = ToolRegistry.getAll().map((t) => t.name).sort();
  const registeredSet = new Set(registered);
  const union = unionNonBuildAllowlist();
  const computedBuildOnly = new Set(getComputedBuildOnlyTools());

  const allowlistNotRegistered = [...union].filter((n) => !registeredSet.has(n));

  const registeredNotAccounted: string[] = [];
  for (const name of registered) {
    if (union.has(name) || GLOBAL_CHAT_TOOLS.has(name)) continue;
    if (!BUILD_ONLY_SET.has(name)) {
      registeredNotAccounted.push(name);
    }
  }

  const buildOnlyMissing = [...computedBuildOnly].filter((n) => !BUILD_ONLY_SET.has(n));
  const buildOnlyExtra = [...BUILD_ONLY_SET].filter(
    (n) => !computedBuildOnly.has(n) && registeredSet.has(n),
  );

  return {
    allowlistNotRegistered,
    registeredNotAccounted,
    buildOnlyDrift: { missing: buildOnlyMissing, extra: buildOnlyExtra },
  };
}
