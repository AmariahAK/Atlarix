/**
 * v12 2.2 — portable workspace permission ruleset (`.atlarix/permissions.json`).
 *
 * Claude-Code-style patterns, evaluated at the SINGLE tool-execution funnel
 * (`runToolExecute`) so ask+build, native AND text-tool paths are all
 * covered uniformly:
 *
 *   { "deny": ["run_command(rm *)", "write_file(.env*)", "browser_*"],
 *     "ask":  ["run_command(git push*)"] }
 *
 * Pattern syntax: `tool_name(glob-over-target)` or a bare tool-name glob.
 * The match target is the command string for run_command/run_tests, the
 * path for file tools, else empty (name-only matching).
 *
 * Semantics (v1, conscious scope):
 * - `deny` is ENFORCED here — a structured tool error the model sees.
 * - `ask` is parsed/validated and logged when matched; the prompt machinery
 *   already lives in the permission interceptor for mutating tools, and
 *   AUTO-ALLOW already exists as the per-workspace command/file permission
 *   stores (WorkspaceTerminalPermissions / WorkspaceFilePermissions UI) —
 *   this file does not duplicate them. Forcing prompts on read-only tools
 *   is a documented follow-up.
 * - The dangerous-commands blocklist remains the hard floor BENEATH user
 *   rules — nothing here can allow what `isDangerousCommand` blocks.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("permission-ruleset");

export interface PermissionRuleset {
  deny: string[];
  ask: string[];
}

interface CompiledRule {
  raw: string;
  toolGlob: RegExp;
  targetGlob: RegExp | null;
}

interface CompiledRuleset {
  deny: CompiledRule[];
  ask: CompiledRule[];
}

const EMPTY: CompiledRuleset = { deny: [], ask: [] };

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

const RULE_SHAPE = /^([a-z0-9_*?]+)(?:\((.*)\))?$/i;

export function compileRule(raw: string): CompiledRule | null {
  const m = RULE_SHAPE.exec(raw.trim());
  if (!m) {
    logger.warn(`Ignoring malformed permission rule: ${JSON.stringify(raw)}`);
    return null;
  }
  return {
    raw,
    toolGlob: globToRegExp(m[1]!),
    targetGlob: m[2] != null ? globToRegExp(m[2]) : null,
  };
}

function compileRuleset(rules: Partial<PermissionRuleset>): CompiledRuleset {
  const compile = (list: unknown): CompiledRule[] =>
    Array.isArray(list)
      ? list
          .filter((r): r is string => typeof r === "string")
          .map(compileRule)
          .filter((r): r is CompiledRule => r !== null)
      : [];
  return { deny: compile(rules.deny), ask: compile(rules.ask) };
}

/** What part of the args a rule's `(glob)` matches, per tool family. */
export function ruleMatchTarget(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "run_command" || toolName === "run_tests") {
    return typeof args.command === "string" ? args.command : "";
  }
  const p = args.path ?? args.file_path ?? args.filePath;
  return typeof p === "string" ? p : "";
}

function ruleMatches(
  rule: CompiledRule,
  toolName: string,
  target: string,
): boolean {
  if (!rule.toolGlob.test(toolName)) return false;
  if (rule.targetGlob == null) return true; // bare tool rule
  return rule.targetGlob.test(target);
}

export type RulesetDecision =
  | { kind: "deny"; rule: string }
  | { kind: "ask"; rule: string }
  | null;

export function evaluateRuleset(
  ruleset: CompiledRuleset,
  toolName: string,
  args: Record<string, unknown>,
): RulesetDecision {
  const target = ruleMatchTarget(toolName, args);
  for (const rule of ruleset.deny) {
    if (ruleMatches(rule, toolName, target))
      return { kind: "deny", rule: rule.raw };
  }
  for (const rule of ruleset.ask) {
    if (ruleMatches(rule, toolName, target))
      return { kind: "ask", rule: rule.raw };
  }
  return null;
}

// ── workspace loading (mtime-cached; missing file = empty ruleset) ──────────

const cache = new Map<string, { mtimeMs: number; compiled: CompiledRuleset }>();

export function rulesetPathFor(workspacePath: string): string {
  return path.join(workspacePath, ".atlarix", "permissions.json");
}

export function loadWorkspaceRuleset(workspacePath: string): CompiledRuleset {
  const file = rulesetPathFor(workspacePath);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return EMPTY; // no rules — behavior identical to pre-2.2
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.compiled;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as Partial<PermissionRuleset>;
    const compiled = compileRuleset(parsed);
    cache.set(file, { mtimeMs, compiled });
    logger.log(
      `Loaded ${compiled.deny.length} deny / ${compiled.ask.length} ask rule(s) from ${file}`,
    );
    return compiled;
  } catch (e) {
    logger.warn(`Failed to parse ${file}: ${String(e)} — treating as empty`);
    cache.delete(file);
    return EMPTY;
  }
}
