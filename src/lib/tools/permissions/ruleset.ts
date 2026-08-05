/**
 * Portable workspace permission ruleset (`.atlarix/permissions.json`).
 *
 * Claude-Code-style patterns, evaluated at the SINGLE tool-execution funnel
 * (`runToolExecute`) so ask+build, native AND text-tool paths are all
 * covered uniformly:
 *
 *   { "deny": ["run_command(rm *)", "write_file(.env*)", "browser_*"] }
 *
 * Pattern syntax: `tool_name(glob-over-target)` or a bare tool-name glob.
 * The match target is the command string for run_command/run_tests, the
 * path for file tools, else empty (name-only matching).
 *
 * A global `~/.atlarix/permissions.json` (same shape) merges BENEATH the
 * workspace file — the deny lists union.
 *
 * THERE IS NO `ask` LIST (removed v14.26.0). It shipped from v12 2.2 as a key
 * that was compiled, matched, returned as a decision — and then written to a log
 * line and dropped on the floor. Its scope note reasoned that mutating tools
 * already prompt via the interceptor, which is true, and that therefore `ask`
 * was only ever a no-op or a duplicate of a prompt the user was getting anyway.
 * A config key that silently does nothing is worse than an absent one: the rule
 * author believes a gate exists. An `ask` key found in a file is now WARNED
 * about at load, so the mistake surfaces instead of hiding.
 *
 * Dangerous commands are NOT a hard floor. They flow through the same permission
 * gate as everything else (see resolveRunCommandPermissionGate): a dangerous
 * command always prompts until the user sets an explicit always-allow keyed by
 * its `danger:<id>` pattern (revocable in Settings), and is never silently
 * auto-approved before then — even in autonomous mode.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("permission-ruleset");

export interface PermissionRuleset {
  deny: string[];
}

interface CompiledRule {
  raw: string;
  toolGlob: RegExp;
  targetGlob: RegExp | null;
}

interface CompiledRuleset {
  deny: CompiledRule[];
}

const EMPTY: CompiledRuleset = { deny: [] };

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
  return { deny: compile(rules.deny) };
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

export type RulesetDecision = { kind: "deny"; rule: string } | null;

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
  return null;
}

// ── loading (mtime-cached per file; missing file = empty ruleset) ───────────

const cache = new Map<string, { mtimeMs: number; compiled: CompiledRuleset }>();

export function rulesetPathFor(workspacePath: string): string {
  return path.join(workspacePath, ".atlarix", "permissions.json");
}

/** Test seam: redirect the global `~/.atlarix/` dir (real home in prod). */
let globalAtlarixDirOverride: string | null = null;
export function setGlobalAtlarixDirForTests(dir: string | null): void {
  globalAtlarixDirOverride = dir;
}

export function globalRulesetPath(): string {
  const home = globalAtlarixDirOverride ?? os.homedir();
  return path.join(home, ".atlarix", "permissions.json");
}

function loadRulesetFile(file: string): CompiledRuleset {
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
    if (Array.isArray((parsed as { ask?: unknown }).ask)) {
      // Say so rather than ignoring it: the whole reason `ask` was removed is
      // that a silently-inert key reads as a gate that is not there.
      logger.warn(
        `${file} contains an "ask" list — that key is NOT supported and is ignored. ` +
          `Use "deny" to block a call outright; mutating tools already prompt for approval.`,
      );
    }
    const compiled = compileRuleset(parsed);
    cache.set(file, { mtimeMs, compiled });
    logger.log(`Loaded ${compiled.deny.length} deny rule(s) from ${file}`);
    return compiled;
  } catch (e) {
    logger.warn(`Failed to parse ${file}: ${String(e)} — treating as empty`);
    cache.delete(file);
    return EMPTY;
  }
}

export function loadWorkspaceRuleset(workspacePath: string): CompiledRuleset {
  return loadRulesetFile(rulesetPathFor(workspacePath));
}

/**
 * Union of two compiled rulesets. Within-list order is immaterial — a match
 * anywhere denies. When one side is empty the other is returned as-is so the
 * common no-rules case stays allocation-free.
 */
export function mergeRulesets(
  a: CompiledRuleset,
  b: CompiledRuleset,
): CompiledRuleset {
  if (a.deny.length === 0) return b;
  if (b.deny.length === 0) return a;
  return { deny: [...a.deny, ...b.deny] };
}

/**
 * Global `~/.atlarix/permissions.json` merged with the workspace ruleset —
 * the funnel's entry point. Neither file existing ⇒ EMPTY ⇒ pre-2.2 behavior.
 */
export function loadEffectiveRuleset(workspacePath: string): CompiledRuleset {
  return mergeRulesets(
    loadRulesetFile(globalRulesetPath()),
    loadWorkspaceRuleset(workspacePath),
  );
}
