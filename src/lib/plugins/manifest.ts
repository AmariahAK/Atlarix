/**
 * What a plugin folder contains, read the same way for the install screen and for
 * every load, in each of the three layouts Atlarix accepts:
 *
 * 1. **Atlarix** — `atlarix-augment.json` at the root:
 *
 *      { "name": "acme-tools", "version": "1.2.0", "description": "…",
 *        "mod": { "main": "mod/index.js", "capabilities": ["ui", "process"] } }
 *
 *    Components sit at the conventional paths below; `mcpServers` may also be inline.
 *
 * 2. **Claude Code** — `.claude-plugin/plugin.json`. Skills, agents, commands,
 *    command hooks and `.mcp.json` load as they are. A Claude Code JS mod is
 *    reported unsupported: its API is Claude Code's.
 *
 * 3. **Skills only** — no manifest, just `skills/<name>/SKILL.md` (or one root
 *    `SKILL.md`): the Agent Skills layout `npx skills add` installs. Named after
 *    the source.
 *
 * Conventional paths, all layouts: `skills/<n>/SKILL.md`, `agents/*.md`,
 * `commands/*.md`, `hooks/hooks.json`, `.mcp.json`.
 *
 * Nothing here runs anything. "Runnable" below means "can run code or reach the
 * network once enabled": hooks, MCP servers, agents that can write or run commands,
 * and a mod. Those get the second confirm, shown in full.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@/lib/skills/priority-skill-loader";
import type { WorkMode } from "@/lib/schemas";
import { firstSentence } from "@/lib/text/first-sentence";
import {
  CLAUDE_TOOL_NAMES,
  describeHook,
  parseHooksJson,
  type PluginHook,
} from "./hooks-config";
import { isValidPluginName } from "./paths";
import { sha256 } from "./tree-hash";

export type PluginFormat = "atlarix" | "claude" | "skills";

/**
 * What a mod may ask `$` for (mod-host.ts). `process` and `net` are not in v1:
 * both would have to wait on the person's approval card, and the isolate runs
 * synchronously — a mod that declares them is told at install they won't run.
 */
export const MOD_CAPABILITIES = [
  "ui",
  "command",
  "prompt",
  "tool",
  "state",
  "fs",
] as const;
export type ModCapability = (typeof MOD_CAPABILITIES)[number];

/** What each capability lets a mod do, as the second confirm says it. */
export const MOD_CAPABILITY_TEXT: Readonly<Record<ModCapability, string>> = {
  ui: "shows a status line, toasts and panes ($.ui)",
  command: "adds slash commands and answers them ($.command, command.run)",
  prompt:
    "rewrites your messages and adds context to every turn (prompt.submit, prompt.compose)",
  tool: "sees every tool call and can block it (tool.call)",
  state: "keeps its own data, up to 64 KB ($.state, $.store)",
  fs: "reads files in the open folder ($.fs.read)",
};

export interface PluginSkill {
  name: string;
  description: string;
  /** Absolute path the model reads with `read_file`. */
  skillPath: string;
}

export interface PluginAgent {
  /** `<plugin>:<file stem>` — namespaced so it never shadows a workspace agent. */
  name: string;
  description: string;
  mode: WorkMode;
  /** The plugin's default. The person's per-plugin model choice wins over it. */
  model?: string;
  /** Atlarix tool names; undefined = the mode's whole set. */
  tools?: string[];
  systemPrompt: string;
}

export interface PluginCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** The prompt, with `$ARGUMENTS` where the typed text goes. */
  template: string;
}

export interface PluginMcpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  /** Env NAMES only are shown; values may be secrets. */
  env?: Record<string, string>;
  url?: string;
}

export interface PluginMod {
  main: string;
  capabilities: ModCapability[];
}

export interface PluginContents {
  format: PluginFormat;
  name: string;
  version: string;
  description: string;
  skills: PluginSkill[];
  agents: PluginAgent[];
  commands: PluginCommand[];
  hooks: PluginHook[];
  mcpServers: PluginMcpServer[];
  mod: PluginMod | null;
  /** Present in the folder, will not run; shown at install, never dropped silently. */
  unsupported: string[];
}

export class PluginManifestError extends Error {}

/**
 * Read a plugin folder. `fallbackName` names a skills-only plugin (its repo or
 * folder name). Throws `PluginManifestError` when the folder is not a plugin.
 */
export function readPluginContents(
  root: string,
  fallbackName: string,
): PluginContents {
  const atlarixManifest = path.join(root, "atlarix-augment.json");
  const claudeManifest = path.join(root, ".claude-plugin", "plugin.json");

  let format: PluginFormat;
  let manifest: Record<string, unknown> = {};
  if (fs.existsSync(atlarixManifest)) {
    format = "atlarix";
    manifest = readJsonObject(atlarixManifest, "atlarix-augment.json");
  } else if (fs.existsSync(claudeManifest)) {
    format = "claude";
    manifest = readJsonObject(claudeManifest, ".claude-plugin/plugin.json");
  } else if (
    fs.existsSync(path.join(root, "skills")) ||
    fs.existsSync(path.join(root, "SKILL.md"))
  ) {
    format = "skills";
  } else {
    throw new PluginManifestError(
      "No augment here: expected atlarix-augment.json, .claude-plugin/plugin.json or skills/",
    );
  }

  const name = (
    typeof manifest.name === "string" ? manifest.name : fallbackName
  )
    .trim()
    .toLowerCase();
  if (!isValidPluginName(name)) {
    throw new PluginManifestError(
      `"${name}" is not a usable augment name (a-z, 0-9, . _ -)`,
    );
  }

  const unsupported: string[] = [];
  const skills = readSkills(root);
  const agents = readAgents(root, name);
  const commands = readCommands(root);

  let hooks: PluginHook[] = [];
  const hooksFile = path.join(root, "hooks", "hooks.json");
  if (fs.existsSync(hooksFile)) {
    const parsed = parseHooksJson(fs.readFileSync(hooksFile, "utf8"));
    hooks = parsed.hooks;
    unsupported.push(...parsed.unsupported);
    if (parsed.claudeModModules.length > 0) {
      unsupported.push(
        `Claude Code mod (${parsed.claudeModModules.join(", ")}): written for Claude Code's API, not Atlarix's`,
      );
    }
  }

  const mcpServers = readMcpServers(root, manifest, unsupported);

  let mod: PluginMod | null = null;
  if (
    format === "atlarix" &&
    manifest.mod &&
    typeof manifest.mod === "object"
  ) {
    mod = readMod(root, manifest.mod as Record<string, unknown>, unsupported);
  }

  return {
    format,
    name,
    version: typeof manifest.version === "string" ? manifest.version : "",
    description:
      typeof manifest.description === "string"
        ? manifest.description
        : (skills[0]?.description ?? ""),
    skills,
    agents,
    commands,
    hooks,
    mcpServers,
    mod,
    unsupported,
  };
}

function readJsonObject(file: string, label: string): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data))
      return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new PluginManifestError(`${label} is not a JSON object`);
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Skills in a folder laid out like a plugin's: `skills/<n>/SKILL.md`, `skills/<n>.md`,
 * or a root `SKILL.md`. Also how `~/.agents/skills` is read (pass its parent).
 */
export function readSkills(root: string): PluginSkill[] {
  const out: PluginSkill[] = [];
  const add = (file: string, fallback: string) => {
    const { data, content } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const name =
      typeof data.name === "string" && data.name ? data.name : fallback;
    const description =
      typeof data.description === "string" && data.description
        ? data.description
        : content;
    out.push({
      name,
      description: firstSentence(description),
      skillPath: file,
    });
  };
  const rootSkill = path.join(root, "SKILL.md");
  if (fs.existsSync(rootSkill)) add(rootSkill, path.basename(root));
  const dir = path.join(root, "skills");
  for (const entry of listDir(dir)) {
    if (entry.isDirectory()) {
      const file = path.join(dir, entry.name, "SKILL.md");
      if (fs.existsSync(file)) add(file, entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      add(path.join(dir, entry.name), entry.name.slice(0, -3));
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const AGENT_STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VALID_MODES: ReadonlySet<string> = new Set([
  "ask",
  "plan",
  "build",
  "debug",
  "review",
]);
const WRITER_TOOLS = new Set(["edit_file", "run_command"]);

/** Claude Code tool name → Atlarix tool name (the inverse of CLAUDE_TOOL_NAMES). */
const FROM_CLAUDE_TOOL: ReadonlyMap<string, string> = new Map(
  Object.entries(CLAUDE_TOOL_NAMES).flatMap(([atlarix, claude]) =>
    claude.map((c) => [c, atlarix] as const),
  ),
);

function readAgents(root: string, pluginName: string): PluginAgent[] {
  const out: PluginAgent[] = [];
  const dir = path.join(root, "agents");
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const stem = entry.name.slice(0, -3);
    if (!AGENT_STEM_RE.test(stem)) continue;
    const { data, content } = parseFrontmatter(
      fs.readFileSync(path.join(dir, entry.name), "utf8"),
    );
    if (!content.trim()) continue;

    const rawTools = Array.isArray(data.tools)
      ? data.tools.map(String)
      : typeof data.tools === "string" && data.tools.trim()
        ? data.tools
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
    // Claude Code names (Read, Bash, …) become Atlarix's; Atlarix names pass through.
    const tools = rawTools
      ? [...new Set(rawTools.map((t) => FROM_CLAUDE_TOOL.get(t) ?? t))]
      : undefined;

    const declaredMode = typeof data.mode === "string" ? data.mode : "";
    const mode: WorkMode = VALID_MODES.has(declaredMode)
      ? (declaredMode as WorkMode)
      : !tools || tools.some((t) => WRITER_TOOLS.has(t))
        ? "build"
        : "ask";

    // Claude Code's model aliases (sonnet, opus, haiku, inherit) are not Atlarix
    // model ids; the plugin runs on the person's choice instead.
    const model =
      typeof data.model === "string" && data.model.includes("/")
        ? data.model
        : undefined;

    out.push({
      name: `${pluginName}:${stem}`,
      description: typeof data.description === "string" ? data.description : "",
      mode,
      model,
      tools,
      systemPrompt: content.trim(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function readCommands(root: string): PluginCommand[] {
  const out: PluginCommand[] = [];
  const dir = path.join(root, "commands");
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3).toLowerCase();
    if (!COMMAND_NAME_RE.test(name)) continue;
    const { data, content } = parseFrontmatter(
      fs.readFileSync(path.join(dir, entry.name), "utf8"),
    );
    if (!content.trim()) continue;
    out.push({
      name,
      description:
        typeof data.description === "string"
          ? data.description
          : firstSentence(content),
      argumentHint:
        typeof data["argument-hint"] === "string"
          ? (data["argument-hint"] as string)
          : undefined,
      template: content.trim(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readMcpServers(
  root: string,
  manifest: Record<string, unknown>,
  unsupported: string[],
): PluginMcpServer[] {
  const maps: Record<string, unknown>[] = [];
  const file = path.join(root, ".mcp.json");
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const servers = data?.mcpServers ?? data;
      if (servers && typeof servers === "object") maps.push(servers);
    } catch {
      unsupported.push(".mcp.json is not valid JSON");
    }
  }
  if (manifest.mcpServers && typeof manifest.mcpServers === "object") {
    maps.push(manifest.mcpServers as Record<string, unknown>);
  }
  const out: PluginMcpServer[] = [];
  for (const servers of maps) {
    for (const [name, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const env =
        s.env && typeof s.env === "object"
          ? Object.fromEntries(
              Object.entries(s.env).map(([k, v]) => [k, String(v)]),
            )
          : undefined;
      if (typeof s.command === "string" && s.command) {
        out.push({
          name,
          transport: "stdio",
          command: s.command,
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env,
        });
      } else if (typeof s.url === "string" && s.url) {
        out.push({ name, transport: "http", url: s.url });
      } else {
        unsupported.push(`MCP server "${name}": no command or url`);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readMod(
  root: string,
  raw: Record<string, unknown>,
  unsupported: string[],
): PluginMod | null {
  const main = typeof raw.main === "string" ? raw.main : "";
  const abs = path.resolve(root, main);
  if (
    !main ||
    !abs.startsWith(path.resolve(root) + path.sep) ||
    !fs.existsSync(abs)
  ) {
    unsupported.push(`mod: "${main}" is not a file in the augment`);
    return null;
  }
  const declared = Array.isArray(raw.capabilities)
    ? raw.capabilities.map(String)
    : [];
  const capabilities = declared.filter((c): c is ModCapability =>
    (MOD_CAPABILITIES as readonly string[]).includes(c),
  );
  for (const c of declared) {
    if (!capabilities.includes(c as ModCapability))
      unsupported.push(`mod capability "${c}"`);
  }
  return { main, capabilities };
}

/** An agent that can change files or run commands. */
export function agentCanRun(agent: PluginAgent): boolean {
  return (
    !agent.tools ||
    agent.tools.some((t) => WRITER_TOOLS.has(t) || t === "mcp_call")
  );
}

/**
 * Everything in a plugin that can run code or reach the network once enabled, one
 * line each, IN FULL: hook commands verbatim, MCP servers with command, args, env
 * names and URL, agents that can run tools with their tool list, and the mod with
 * its capabilities. This is the second confirm, and its digest is what the person
 * approved — a later load whose runnables differ is not the plugin they agreed to.
 */
export function describeRunnables(c: PluginContents): string[] {
  const lines: string[] = [];
  for (const h of c.hooks) lines.push(`hook ${describeHook(h)}`);
  for (const s of c.mcpServers) {
    if (s.transport === "stdio") {
      // Values too: `NODE_OPTIONS`, `PATH` or `DYLD_*` change what the command
      // runs. Only a value whose NAME says it is a secret is hidden.
      const env =
        s.env && Object.keys(s.env).length
          ? ` (env: ${Object.entries(s.env)
              .map(([k, v]) => `${k}=${SECRET_NAME_RE.test(k) ? "…" : v}`)
              .join(" ")})`
          : "";
      lines.push(
        `MCP server ${s.name}: ${[s.command, ...(s.args ?? [])].join(" ")}${env}`,
      );
    } else {
      lines.push(`MCP server ${s.name}: ${s.url}`);
    }
  }
  for (const a of c.agents) {
    if (agentCanRun(a)) {
      lines.push(
        `agent ${a.name}: ${a.tools ? a.tools.join(", ") : `every ${a.mode} tool`}`,
      );
    }
  }
  if (c.mod) {
    // The `$` surface in full (mod-host.ts), one line per declared capability,
    // so the second confirm says what the mod can DO, not just a word.
    lines.push(
      `mod ${c.mod.main}: runs isolated (no files, network or programs), 32 MB, 200 ms per event`,
    );
    for (const cap of c.mod.capabilities)
      lines.push(`mod ${c.mod.main} ${cap}: ${MOD_CAPABILITY_TEXT[cap]}`);
  }
  // Shown on a terminal: an escape sequence in a plugin's text must not be able
  // to redraw what the person reads at the confirm.
  return lines.map(visible);
}

const SECRET_NAME_RE = /key|token|secret|passw|auth|credential|cookie/i;

/** Control characters as `\\xNN`, so nothing in a line is invisible or acts on the screen. */
export function visible(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/** What the person approved: compared on every load (`registry.ts`). */
export function runnablesDigest(lines: string[]): string {
  return sha256(lines.join("\n"));
}
