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
 * A file here is a FULL AGENT the user SELECTS. That is the only per-project
 * customisation of agent behaviour there is.
 *
 * THIS NOTE USED TO DESCRIBE A "mode-skill override" as a sibling feature, and it
 * was wrong three ways, which is worth recording because the wrongness is what let
 * the thing survive unexamined. It cited `docs/atlarix-contract.md`, a file that
 * does not exist. It named `.atlarix/agents/`, while the loader actually read
 * `.atlarix/skills/`. And it framed as a feature something that let any cloned repo
 * replace Atlarix's own operating instructions — removed in v14.45, see the header
 * of `src/lib/skills/skill-loader.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import type { WorkMode } from "@/lib/schemas";
import { loadPlugins } from "@/lib/plugins/registry";
import { BUILTIN_AGENTS, listBuiltinAgents } from "./builtin-agents";

const logger = log.scope("user-agents");

/**
 * Mode names, reserved so a user agent cannot impersonate a work mode.
 *
 * It is NOT a security control and never was, despite reading like one: it guards
 * `.atlarix/agents/` against these five stems, and the mode-skill loader never read
 * that directory. With the workspace override gone (v14.45) there is nothing left to
 * collide with — the reservation stays because a selectable agent called "build-mode"
 * would still be confusing in the picker, which is the honest reason for it.
 *
 * Note the spellings do not match `skill-registry.ts`'s `modes/build-mode`, so no
 * shared constant ties the two lists together and no test enforces parity. Adding a
 * sixth work mode will not update this set.
 */
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

/**
 * List available agents: built-ins overlaid by the workspace's `.atlarix/agents/`
 * (a workspace file of the same name WINS, so users can retune a built-in).
 */
export function listUserAgents(workspacePath: string): UserAgent[] {
  const byName = new Map<string, UserAgent>();
  for (const b of listBuiltinAgents()) byName.set(b.name, b);

  const dir = userAgentsDir(workspacePath);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // no workspace agents dir — built-ins only
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const stem = entry.slice(0, -3);
    if (RESERVED_AGENT_NAMES.has(stem)) continue;
    try {
      const agent = toUserAgent(
        stem,
        fs.readFileSync(path.join(dir, entry), "utf8"),
      );
      if (agent) byName.set(agent.name, agent); // workspace overrides built-in
    } catch (e) {
      logger.warn(`Failed to read user agent ${entry}: ${String(e)}`);
    }
  }
  for (const agent of listPluginAgents(workspacePath)) byName.set(agent.name, agent);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The installed plugins' agents, one line each, for the prompt — they are not in
 * the project, so `glob` over `.atlarix/agents/` cannot find them. Empty when no
 * installed plugin has an agent.
 */
export function formatInstalledAgentsForPrompt(workspacePath: string | null | undefined): string {
  const agents = listPluginAgents(workspacePath ?? "");
  if (agents.length === 0) return "";
  return [
    `## Installed agents (${agents.length})`,
    "From silks the user installed. Start one with `task` and its name as `subagent_type`.",
    ...agents.map((a) => (a.description ? `- **${a.name}** — ${a.description}` : `- **${a.name}**`)),
  ].join("\n");
}

/**
 * Agents from installed plugins, `<plugin>:<agent>` — the colon keeps them from
 * ever shadowing a workspace or built-in agent. Verified on this load
 * (plugins/registry.ts). The person's model for the plugin wins over the
 * plugin's own default.
 */
function listPluginAgents(workspacePath: string): UserAgent[] {
  const out: UserAgent[] = [];
  try {
    for (const p of loadPlugins(workspacePath || null).plugins) {
      for (const a of p.contents.agents) {
        out.push({ ...a, model: p.record.model ?? a.model });
      }
    }
  } catch (e) {
    logger.warn(`Failed to read plugin agents: ${String(e)}`);
  }
  return out;
}

/**
 * Retired built-in names → their v14.52.0 replacement. Old transcripts, habit and
 * workspace docs still say `explorer` or `implementer`; without this they resolved
 * to null and silently degraded to a generic scout — a named writer became a
 * read-only worker. `qa` maps to explore, not build: QA never edited anything.
 */
export const BUILTIN_AGENT_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    explorer: "explore",
    architect: "explore",
    qa: "explore",
    implementer: "build",
  });

function readWorkspaceAgent(
  workspacePath: string,
  name: string,
): UserAgent | null {
  const file = path.join(userAgentsDir(workspacePath), `${name}.md`);
  try {
    return toUserAgent(name, fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load one agent by name: a workspace `.atlarix/agents/<name>.md` if present,
 * else the built-in of that name (following a retired alias), else null.
 */
export function loadUserAgent(
  workspacePath: string,
  name: string,
): UserAgent | null {
  if (!name || RESERVED_AGENT_NAMES.has(name)) return null;
  // Guard against traversal — agent names are bare file stems.
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  if (name.includes(":")) {
    return listPluginAgents(workspacePath).find((a) => a.name === name) ?? null;
  }
  // A workspace file under the OLD name still wins — the user wrote it.
  const exact = readWorkspaceAgent(workspacePath, name);
  if (exact) return exact;
  const canonical = BUILTIN_AGENT_ALIASES[name] ?? name;
  if (canonical !== name) {
    const overridden = readWorkspaceAgent(workspacePath, canonical);
    if (overridden) return overridden;
  }
  return BUILTIN_AGENTS[canonical] ?? null;
}

/**
 * A sub-agent is a WRITER iff its effective toolset includes `edit_file`: it must
 * run on a write-capable profile (build/debug — the modes that offer `edit_file`)
 * AND either declare `edit_file` in its `tools` allowlist or omit the allowlist
 * (inheriting the full writer toolset). Mirrors the intersection run-subagent
 * applies, so this is the single source of truth for the writer decision.
 */
export function agentIsWriter(agent: UserAgent): boolean {
  if (agent.mode !== "build" && agent.mode !== "debug") return false;
  return !agent.tools || agent.tools.includes("edit_file");
}

/**
 * Whether a `task({...})` spawn will run as a writer (→ proposal set). A
 * named writer agent implies write without `write:true`; otherwise the explicit
 * `write` flag decides.
 */
export function subagentWillWrite(opts: {
  write?: boolean;
  subagentType?: string;
  workspacePath: string;
}): boolean {
  const named = opts.subagentType?.trim();
  if (named) {
    const agent = loadUserAgent(opts.workspacePath, named);
    if (agent) return agentIsWriter(agent);
  }
  return opts.write === true;
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
