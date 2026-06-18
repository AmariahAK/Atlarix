/**
 * v12 Tier 7A — user-definable agents from `.atlarix/agents/<name>.md`.
 *
 * "Configure how AIs work in MY space": a committable markdown file =
 *   ---
 *   description: Cautious reviewer
 *   mode: ask              # base work-mode profile (default: build)
 *   model: anthropic/claude-opus-4-8   # optional per-turn model override
 *   tools: [read_file, glob, grep]   # optional allowlist subset
 *   ---
 *   <system prompt body — prepended into the turn's system header>
 *
 * Nearly free after 0.1: an agent is the unified loop's behavior +
 * `AgentProfile` parameterized from disk — a custom system block + a tool-
 * allowlist intersection + a model override on top of its base work mode.
 *
 * NOTE the distinction (documented in docs/atlarix-contract.md): a file here
 * is a FULL AGENT the user SELECTS; the mode-skill override files
 * (`.atlarix/agents/<modes/build-mode>.md`, loaded by skill-loader) REPLACE a
 * built-in mode's guidance. Reserved mode-skill names are skipped by the
 * user-agent loader so the two never collide.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import type { WorkMode } from "@/lib/schemas";

const logger = log.scope("user-agents");

/** Mode-skill override names (skill-loader's territory) — not user agents. */
const RESERVED_AGENT_NAMES = new Set([
  "ask-mode",
  "plan-mode",
  "build-mode",
  "debug-mode",
  "review-mode",
]);

const VALID_MODES: ReadonlySet<string> = new Set([
  "ask",
  "plan",
  "build",
  "debug",
  "review",
]);

export interface UserAgent {
  /** File stem (the selectable id). */
  name: string;
  description: string;
  /** Base work-mode profile this agent runs on. */
  mode: WorkMode;
  /** Optional `provider/model` or bare model name override. */
  model?: string;
  /** Optional tool-name allowlist (intersected with the mode's offered set). */
  tools?: string[];
  /** Markdown body — the custom system block. */
  systemPrompt: string;
}

interface ParsedFm {
  data: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(raw: string): ParsedFm {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, unknown> = {};
  const lines = m[1]!.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1]!;
    const rest = (kv[2] ?? "").trim();
    if (rest === "") {
      // block list
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j]!)) {
        items.push(stripQuotes(lines[j]!.replace(/^\s*-\s+/, "").trim()));
        j++;
      }
      data[key] = items;
      i = j;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      // Inline array — accept JSON (`["a","b"]`) AND unquoted YAML-style
      // (`[a, b]`), which is what hand-written frontmatter usually has.
      const inner = rest.slice(1, -1).trim();
      data[key] =
        inner === ""
          ? []
          : inner
              .split(",")
              .map((v) => stripQuotes(v.trim()))
              .filter((v) => v.length > 0);
      i++;
      continue;
    }
    data[key] = stripQuotes(rest);
    i++;
  }
  return { data, body: m[2] ?? "" };
}

function stripQuotes(s: string): string {
  return (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s;
}

export function userAgentsDir(workspacePath: string): string {
  return path.join(workspacePath, ".atlarix", "agents");
}

function toUserAgent(name: string, raw: string): UserAgent | null {
  const { data, body } = parseFrontmatter(raw);
  if (!body.trim()) {
    logger.warn(`User agent "${name}" has no system-prompt body — skipped`);
    return null;
  }
  const modeRaw = typeof data.mode === "string" ? data.mode : "build";
  const mode = (VALID_MODES.has(modeRaw) ? modeRaw : "build") as WorkMode;
  return {
    name,
    description: typeof data.description === "string" ? data.description : "",
    mode,
    model:
      typeof data.model === "string" && data.model ? data.model : undefined,
    tools: Array.isArray(data.tools)
      ? (data.tools as unknown[]).map(String)
      : undefined,
    systemPrompt: body.trim(),
  };
}

/** List the workspace's user-defined agents (excludes mode-skill overrides). */
export function listUserAgents(workspacePath: string): UserAgent[] {
  const dir = userAgentsDir(workspacePath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const agents: UserAgent[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const stem = entry.slice(0, -3);
    if (RESERVED_AGENT_NAMES.has(stem)) continue;
    try {
      const agent = toUserAgent(
        stem,
        fs.readFileSync(path.join(dir, entry), "utf8"),
      );
      if (agent) agents.push(agent);
    } catch (e) {
      logger.warn(`Failed to read user agent ${entry}: ${String(e)}`);
    }
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load one user agent by name, or null if absent/reserved/invalid. */
export function loadUserAgent(
  workspacePath: string,
  name: string,
): UserAgent | null {
  if (!name || RESERVED_AGENT_NAMES.has(name)) return null;
  // Guard against traversal — agent names are bare file stems.
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  const file = path.join(userAgentsDir(workspacePath), `${name}.md`);
  try {
    return toUserAgent(name, fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The system block prepended into the turn's header when an agent is active. */
export function renderUserAgentSystemBlock(agent: UserAgent): string {
  return [
    `# Active agent: ${agent.name}`,
    agent.description ? `_${agent.description}_` : "",
    "",
    agent.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n");
}
