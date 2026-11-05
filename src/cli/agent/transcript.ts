/**
 * The CLI transcript as data: the agent's messages (the same array the desktop
 * renders, sent whole on every `chat:response:chunk`) turned into cells.
 *
 * Assistant text is split by the desktop's own parser (parseAssistantMessageParts),
 * so tool calls, thinking and prose come apart exactly as they do in the app.
 * Pure: the TUI renders cells; src/__tests__/cli-transcript.test.ts pins the rules.
 */
import { writePrevious } from "@/lib/chat/write-previous";
import { noopSummary } from "@/lib/chat/stream-tool-display";
import { plainStepText } from "@/lib/tasks/plan-checklist";
import { displayTitle } from "@/shared/mcp-catalog";
import { BUILD_FROM_PLAN_PROMPT } from "@/lib/work-mode";
import { computeDiffHunks } from "@/lib/diff/compose-hunks";
import { peerPreview, peerSurfaceLabel, sentToName, splitPeerMessages } from "@/lib/peers/peer-message";
import {
  parseAssistantMessageParts,
  type AssistantMessagePart,
} from "@/lib/chat/assistant-message-parts";
import { stripQuestionsArtifactForDisplay } from "@/lib/chat/ask-user-artifacts";
import { extractInlineSourcesFromContent } from "@/lib/chat/citation-sources";
import { stripSystemReminders } from "@/lib/streaming/system-reminder";

export interface ChatMessageLike {
  id: number | string;
  role: string;
  content: string;
  /** What the model was sent, when it differs from what was shown (a paste expanded). */
  modelContent?: string | null;
}

export type ToolStatus = "running" | "success" | "error" | "interrupted";

export interface ToolLine {
  id: string;
  /** What happened, one word: Read, Search, Run, Edit … */
  verb: string;
  /** What it happened to: a path, a pattern, a command. */
  target: string;
  status: ToolStatus;
  /** The raw result envelope, as the agent recorded it. */
  result?: string;
  error?: string;
  /** The result as a person reads it (ctrl+o): matches, a command's output. */
  output?: string;
  /** One line under the call, always shown: "1 match in a.ts", the first output line. */
  summary?: string;
  /** A sub-agent's own tool calls, nested under its `task` line (withDelegations). */
  children?: ToolLine[];
  /** What a running sub-agent says it is doing. */
  progress?: string;
  /** A sub-agent's name, when it started (epoch ms), tokens so far, and its report once done. */
  agent?: { label?: string; startedAt?: number; tokens?: number; report?: string };
  /** An edit's changes, from its arguments: drawn as + / − lines under the call. */
  diff?: EditDiff;
  /**
   * A message from another Atlarix session: who sent it and what its one row
   * shows inline ("Message from X (CLI): <preview…>"); `output` is the whole text.
   */
  peer?: { from: string; surface: string; preview: string; more: boolean };
}

export interface EditDiff {
  added: number;
  removed: number;
  /**
   * Every changed line, with a little context; the renderer decides how many to
   * show. `no` is the line's number within its block (`block`); `starts` turns
   * it into the file's line number once the block is found in the file.
   */
  lines: Array<{ kind: "add" | "remove" | "context" | "gap"; text: string; no?: number; block?: number }>;
  /** Each block's new text, to find it in the file. */
  blocks: string[];
  /** Where each block starts in the file (1-based), when found. */
  starts?: Array<number | null>;
}

/** A sub-agent the turn started, as its `chat:activity` events describe it. */
export interface Delegation {
  id: string;
  /** The reply it belongs to, and which of that reply's `task` calls it is (0, 1, …). */
  assistantId: string;
  index: number;
  status: "running" | "success" | "error" | "interrupted";
  progress?: string;
  summary?: string;
  children: ToolLine[];
  /** From its start event: what it was called and asked, and when. */
  label?: string;
  task?: string;
  startedAt?: number;
  /** Tokens it has used so far (its `subagent_tokens` events). */
  tokens?: number;
  /** What it has written so far, by segment: its own transcript, for the agent view. */
  text?: Map<string, string>;
}

/** A sub-agent's tool call, from its `tool_use` activity event. */
export function activityToolLine(p: {
  id?: unknown;
  toolName?: unknown;
  status?: unknown;
  toolArgs?: unknown;
  resultText?: unknown;
  detail?: unknown;
}): ToolLine {
  const name = typeof p.toolName === "string" ? p.toolName : "tool";
  const raw = typeof p.resultText === "string" ? p.resultText : undefined;
  const failed = (p.status === "error" || p.status === "failed") && !noopSummary(name, raw);
  const st = p.status === "running" ? "running" : failed ? "error" : "success";
  const r = toolResultText(name, raw);
  return {
    id: String(p.id ?? `${name}-${Math.random()}`),
    verb: VERBS[name] ?? name.replace(/_/g, " "),
    target:
      toolTarget(name, p.toolArgs, typeof p.resultText === "string" ? p.resultText : undefined) ||
      (typeof p.detail === "string" ? p.detail.split("\n")[0]!.slice(0, 80) : ""),
    status: st,
    result: raw,
    output: r.text || undefined,
    summary: st === "running" ? undefined : summarize(name, r),
  };
}

/**
 * Put each sub-agent's work under the `task` line that started it: the Nth
 * delegation of a reply belongs to that reply's Nth `task` call (cells key them
 * `<message>:t:task_<N>`, in call order — the order delegations start in).
 */
export function withDelegations(cells: Cell[], delegations: Iterable<Delegation>): Cell[] {
  const byCell = new Map<string, Delegation>();
  for (const d of delegations) byCell.set(`${d.assistantId}:t:task_${d.index}`, d);
  if (!byCell.size) return cells;
  return cells.map((c) => {
    if (c.kind !== "tool") return c;
    const d = byCell.get(c.id);
    if (!d) return c;
    // A sub-agent's first "progress" is often its own prompt read back: not progress.
    const echo = !!d.progress && !!d.task && d.task.replace(/\s+/g, " ").startsWith(d.progress.replace(/\s+/g, " ").slice(0, 40));
    return {
      ...c,
      tool: {
        ...c.tool,
        // The call returns at once for a background agent; the row follows the
        // agent itself (QA saw ◌ stay after both had finished).
        status: d.status === "running" ? c.tool.status : d.status === "error" || d.status === "interrupted" ? d.status : "success",
        children: d.children,
        progress: d.status === "running" && !echo ? d.progress : undefined,
        agent: {
          label: d.label,
          startedAt: d.startedAt,
          tokens: d.tokens,
          report: d.status !== "running" ? d.summary : undefined,
        },
        summary:
          d.status === "running"
            ? c.tool.summary
            : (firstSentence(d.summary ?? "")?.slice(0, 160) ??
              (c.tool.summary === "running in the background" ? "finished" : c.tool.summary)),
      },
    };
  });
}

export type Cell =
  /** `chips`: what came with it: images, pastes, files (drawn under the message). */
  /** `full`: the message with its pastes expanded, when it had any. */
  | { kind: "user"; id: string; text: string; chips?: string[]; full?: string }
  /** Your answers to the agent's questions (sent as `***Q:*** … → ***A:*** …` lines). */
  | { kind: "answers"; id: string; pairs: Array<{ question: string; answer: string }> }
  /** `ms`: how long it took, when this session watched it being written. */
  | { kind: "thought"; id: string; text: string; ms?: number }
  | { kind: "markdown"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolLine }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string }
  /** After a finished turn: its mode, model and how long it took. */
  | { kind: "footer"; id: string; text: string; interrupted?: boolean }
  /** Coming back after a while away: one line on where things stand (lib/recap). Never sent to the model. */
  | { kind: "recap"; id: string; text: string };

const VERBS: Record<string, string> = {
  read_file: "Read",
  grep: "Search",
  glob: "Find",
  run_command: "Run",
  edit_file: "Edit",
  web_search: "Web search",
  read_url: "Fetch",
  task: "Agent",
  subagents: "Agents",
  browser: "Browser",
  browser_inspect: "Inspect page",
  ask_user: "Question",
  plan: "Plan",
  background_jobs: "Jobs",
  session_search: "Search sessions",
  mcp_call: "MCP",
  mcp_servers: "MCP servers",
  list_available_mcps: "MCP servers",
  compress_context: "Compact",
  schedule_wakeup: "Wake up",
  automations: "Automation",
  relic: "Relic",
  read_attachment: "Read attachment",
  view_image: "View image",
  computer: "Screen",
  transcribe_audio: "Transcribe",
  list_sessions: "Sessions",
  send_message: "Message",
  list_attachments: "Attachments",
  tool_help: "Tool help",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A send_message call's recipient and text, for the row that names who it is to. */
function sendMessageText(args: unknown): { to: string; text: string } | null {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const to = str(a.to);
  const text = str(a.message);
  if (!to && !text) return null;
  return { to, text };
}

/**
 * The one thing worth naming about a call, from its arguments — and, for a
 * few tools whose answer IS the point (list_sessions), its result text.
 */
export function toolTarget(toolName: string, args: unknown, resultText?: string): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (toolName) {
    case "read_file":
    case "edit_file":
      return str(a.path) || str(a.file_path) || str(a.target_file);
    case "grep":
      return a.pattern ? `"${str(a.pattern)}"` + (a.path ? ` in ${str(a.path)}` : "") : "";
    case "glob":
      return str(a.pattern) || str(a.glob);
    case "run_command":
      return str(a.command);
    case "relic":
      return str(a.title) || str(a.id);
    case "web_search":
      return a.query ? `"${str(a.query)}"` : "";
    case "read_url":
      return str(a.url);
    case "task":
      return str(a.description) || str(a.agent) || str(a.subagent_type);
    case "browser":
      return [str(a.action), str(a.url)].filter(Boolean).join(" ");
    case "computer": {
      // "Screen  left click 640,400", "Screen  type "hello"": what it did on
      // the screen. OpenAI's native tool sends a batch of `actions`.
      if (Array.isArray(a.actions)) return a.actions.map((x) => str((x as { type?: unknown })?.type)).filter(Boolean).join(", ");
      const what = str(a.action).replace(/_/g, " ");
      const at = Array.isArray(a.coordinate) ? (a.coordinate as unknown[]).join(",") : "";
      const text = str(a.text) ? `"${str(a.text).slice(0, 40)}"` : "";
      return [what, at, text].filter(Boolean).join(" ");
    }
    case "mcp_call":
      return [str(a.server), str(a.tool).replace(/[_-]+/g, " ")].filter(Boolean).join(" · ");
    case "mcp_servers": {
      // "suggest · Linear", not the registry id "app.linear/linear" (QA #8).
      const server = str(a.server);
      const title = server.includes("/") ? displayTitle({ name: server }) : server;
      return [str(a.operation), title || (a.query ? `"${str(a.query)}"` : "")].filter(Boolean).join(" · ");
    }
    case "plan": {
      // "◇ Plan  step 3 done", not a bare "◇ Plan" (owner, 2026-10-05).
      const op = str(a.operation);
      if (op === "write") return ["write", str(a.title).replace(/`/g, "")].filter(Boolean).join(" · ");
      if (op === "set_status") return `status → ${str(a.plan_status) || str(a.status)}`;
      if (op === "update_step") {
        // A step's text as it reads, without its markdown backticks (QA E8).
        const which = a.step_index != null ? `step ${String(a.step_index)}` : a.step_text ? `"${plainStepText(str(a.step_text))}"` : "step";
        return [which, str(a.state) || str(a.status)].filter(Boolean).join(" → ");
      }
      if (op === "append_step") return ["add step", plainStepText(str(a.step_text))].filter(Boolean).join(" · ");
      return op;
    }
    case "automations": {
      // "◇ Automation  create · Weekday tests", not a bare "◇ Automation" (QA).
      const op = str(a.operation);
      const what = op === "set_notify" ? (a.notify_agent ? "tell the agent" : "stop telling the agent") : op;
      return [what, str(a.name)].filter(Boolean).join(" · ");
    }
    case "background_jobs":
      // Not the tool's own vocabulary ("Jobs cancel op_179…"): what it did.
      if (a.operation === "cancel") return "stop a background job";
      if (a.operation === "output") return "read a background job's output";
      if (a.operation === "list") return "list background jobs";
      return [str(a.operation), str(a.command)].filter(Boolean).join(" ");
    case "subagents":
      if (a.operation === "cancel") return "stop a sub-agent";
      if (a.operation === "output") return "read a sub-agent's progress";
      if (a.operation === "list") return "list running sub-agents";
      return str(a.operation);
    case "send_message": {
      // "→ QA · \"the build is green\"", or what it steered: mode/model/plan
      // (owner, 2026-11-01: the row said only "Message").
      const msg = str(a.message).trim();
      const steer = [
        a.mode ? `mode ${str(a.mode)}` : "",
        str(a.model),
        a.plan ? `plan ${str(a.plan)}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      const said = msg ? `"${msg.split("\n")[0]!.slice(0, 60)}"` : steer;
      // Who it went to by NAME: `to` may be a session id ("→ 9e0cd4fd-…",
      // QA 2026-11-06); the result names the session it resolved to.
      const to = sentToName(resultText) ?? str(a.to);
      return [to ? `→ ${to}` : "", said].filter(Boolean).join(" · ");
    }
    case "list_sessions": {
      // "· 6 live": the count is in the result, not the args (owner,
      // 2026-11-01: the row said only "Sessions"). The session lines stop at
      // the first blank line — a plan or reply appended below the list is not
      // another session.
      const asked = a.plan_of ? `plan of ${str(a.plan_of)}` : a.result_of ? `latest turn of ${str(a.result_of)}` : "";
      let text = "";
      if (typeof resultText === "string") {
        try {
          const v = JSON.parse(resultText) as { text?: unknown; result?: unknown };
          text = typeof v.text === "string" ? v.text : typeof v.result === "string" ? v.result : "";
        } catch {
          text = unfence(resultText);
        }
      }
      const list = text.split("\n\n")[0] ?? "";
      const live = (list.match(/^- /gm) ?? []).length;
      const count = live ? `${live} live` : text.includes("No other Atlarix sessions") ? "none live" : "";
      return [asked, count].filter(Boolean).join(" · ");
    }
    default:
      return "";
  }
}

/** Drop the <untrusted-data …> fence the agent wraps command and page output in. */
function unfence(text: string): string {
  return text.replace(/<untrusted-data[^>]*>\n?/g, "").replace(/\n?<\/untrusted-data>/g, "");
}

/**
 * The human part of a tool result envelope. Results arrive as JSON (e.g.
 * `{"success":true,"result":{"result":"1 match(es)…","ui":{…}}}` or, for a
 * command, `{"output":"<untrusted-data …>…","exitCode":0}`); a person wants the
 * text inside, not the envelope.
 */
/** The text parts of an MCP tool result (`content: [{type:"text",text}]`), wherever the wrappers put it. */
function mcpContentText(v: unknown, depth = 0): string {
  // The result can arrive as its JSON text (QA: `{"content":[…],"isError":false}` on the row),
  // inside the `<untrusted-data …>` fence the model reads it in. The row shows what is inside.
  if (typeof v === "string" && depth <= 4) {
    const inner = v.replace(/^\s*<untrusted-data\b[^>]*>\s*/, "").replace(/\s*<\/untrusted-data>\s*$/, "");
    if (!/^\s*\{/.test(inner)) return "";
    try {
      return mcpContentText(JSON.parse(inner), depth + 1);
    } catch {
      return "";
    }
  }
  if (!v || typeof v !== "object" || depth > 4) return "";
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.content)) {
    const text = o.content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  if (o.structuredContent && typeof o.structuredContent === "object") return JSON.stringify(o.structuredContent);
  return mcpContentText(o.result, depth + 1);
}

export function toolResultText(toolName: string, raw: string | undefined): { text: string; exitCode?: number; failed?: boolean } {
  if (!raw) return { text: "" };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    // A stored result can be cut short, which breaks its JSON. Never show that
    // envelope (`{"success":true,"result":{…`) as the result line: take its
    // message if one survived, else nothing.
    if (/^\s*[{[]/.test(raw)) {
      const m = raw.match(/"(?:message|progress|note|error|result)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return { text: m ? unfence(m[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"')).trim() : "" };
    }
    return { text: unfence(raw).trim() };
  }
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const inner = (o.result && typeof o.result === "object" ? o.result : {}) as Record<string, unknown>;
  const exitCode = typeof o.exitCode === "number" ? o.exitCode : undefined;
  const failed = o.success === false;
  if (toolName === "relic") {
    // "└ Published https://atlarix.dev/r/…" or "└ Saved .atlarix/relics/…".
    const r = (typeof inner.url === "string" || typeof inner.path === "string" ? inner : o) as Record<string, unknown>;
    if (typeof r.url === "string") return { text: `Published ${r.url}`, failed };
    if (typeof r.path === "string") return { text: `Saved ${r.path}`, failed };
  }
  // An MCP tool's answer is its `content` text, not the envelope around it (QA #8).
  if (toolName === "mcp_call" && !(typeof o.error === "string" && o.error.trim())) {
    const said = mcpContentText(o);
    if (said) return { text: said, failed };
  }
  if (toolName === "background_jobs" && typeof inner.count === "number") {
    return { text: inner.count ? `${inner.count} running` : "none running", failed };
  }
  const pick = [
    toolName === "run_command" ? o.output : undefined,
    inner.result,
    inner.message,
    inner.progress,
    inner.note,
    typeof inner.output === "string" ? inner.output : undefined,
    inner.error,
    typeof o.result === "string" ? o.result : undefined,
    o.output,
    o.content,
    // list_sessions / send_message return their text as `text`, not `result`.
    (toolName === "list_sessions" || toolName === "send_message") && typeof o.text === "string"
      ? o.text
      : undefined,
    // The message says what happened ("No file at path …"); the error is its code.
    o.message,
    o.error,
  ].find((x) => typeof x === "string" && x.trim()) as string | undefined;
  return { text: unfence(pick ?? "").trim(), exitCode, failed };
}

/**
 * The first real sentence of a report: past headings and markdown marks
 * ("## Direct answer" is not what the agent found).
 */
export function firstSentence(md: string): string | undefined {
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^(```|---|\|)/.test(line)) continue;
    const plain = line.replace(/^[-*+]\s+|^\d+[.)]\s+/, "").replace(/\*\*|__|`/g, "").trim();
    if (!plain) continue;
    return /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  }
  return undefined;
}

function summarize(toolName: string, r: { text: string; exitCode?: number; failed?: boolean }): string | undefined {
  // Command output comes in "=== STDOUT ===" / "=== STDERR ===" sections; the
  // markers are plumbing (QA #37a).
  const SECTION = /^=== (STDOUT|STDERR) ===$/;
  const lines = r.text.split("\n").map((l) => l.trim());
  const first = lines.find((l) => l && !SECTION.test(l));
  // The note to the model ("Background command started (job_id: …) … do not
  // poll …") is not for the person reading (QA).
  if (toolName === "run_command" && first?.startsWith("Background command started")) return "started in the background";
  if (toolName === "background_jobs" && first?.startsWith("Cancellation requested")) return "stopping";
  if (toolName === "run_command") {
    const failedRun = r.exitCode != null && r.exitCode !== 0;
    const exit = failedRun ? `exit ${r.exitCode}` : "";
    // A failure says why: the last stderr line ("tsgo: command not found"), not
    // the shell's echo of the command on the first (QA #37b).
    let said = first;
    if (failedRun) {
      const err = lines.indexOf("=== STDERR ===");
      // PowerShell's error trailer ("+ CategoryInfo …", "+ FullyQualifiedErrorId
      // …", "At line:1 char:1", "~~~") is not the reason: its first line is
      // ("npx : The term 'npx' is not recognized…", QA, Windows).
      // PowerShell also wraps that message over several lines, so it is the
      // lines before its trailer, joined (QA, Windows VM recheck).
      const PS_NOISE = /^(\+ |At line:\d|At [A-Za-z]:\\|~+$)/;
      const out = (err >= 0 ? lines.slice(err + 1) : lines).filter((l) => l && !SECTION.test(l));
      const trailer = out.findIndex((l) => PS_NOISE.test(l));
      if (trailer > 0) said = out.slice(0, trailer).join(" ").replace(/\s+/g, " ");
      else said = out.filter((l) => !PS_NOISE.test(l)).at(-1) ?? first;
    }
    return [said ?? (r.exitCode === 0 ? "(no output)" : ""), exit].filter(Boolean).join(" · ") || undefined;
  }
  // "No files found matching pattern: … Often an extension or casing issue —
  // try …" is advice for the model; the person reads "no files" (QA #37c).
  if (toolName === "glob" && first?.startsWith("No files found")) return "no files";
  // The executor's generic "Successfully executed operation" says nothing.
  if (toolName === "automations" && first?.startsWith("Successfully executed")) return "done";
  // The plan tool's tally is written to the model ("…, 2 left for you"); the
  // person reads it as their own to-do list (QA). Keep the count, drop that.
  if (toolName === "plan" && first) return first.replace(/,\s*(?:none|\d+) left for you/, "");
  // A failure's first sentence says what went wrong; what follows ("Use
  // list_files to find the correct path.") is meant for the model.
  if (r.failed && first) return firstSentence(first) ?? first;
  if (toolName === "grep" && first) return first.replace(/:$/, "").replace(/match\(es\)/, "matches").replace(/file\(s\)/, "files");
  // A read says which lines it read: "Lines: 1-240 of 3641" or "Lines: 1-80 (complete)".
  if (toolName === "read_file" && first?.startsWith("File: ")) {
    const range = /^Lines: (\d+)-(\d+)(?: of (\d+)| \(complete\))?/m.exec(r.text);
    if (range) {
      const [, from, to, of] = range;
      return of ? `lines ${from}–${to} of ${of}` : `${to} line${to === "1" ? "" : "s"}`;
    }
    const n = r.text.split("\n").filter((l) => /^\s*\d+[\t│|]/.test(l)).length;
    return n ? `${n} line${n === 1 ? "" : "s"}` : undefined;
  }
  // A find: "Found 500 file(s) (newest first):" → "500 files".
  if (toolName === "glob" && first) {
    const found = /^Found (\d+) file\(s\)/.exec(first);
    if (found) return `${found[1]} file${found[1] === "1" ? "" : "s"}`;
  }
  return first;
}

/**
 * What an edit_file call changed, from its own arguments: a write is the text
 * it replaced (`previous`, when known) against its content, else all
 * additions; a replace (or each of its `edits`) is the old text against the
 * new. Line numbers are the snippet's, not the file's, so none are shown.
 */
export function editDiff(args: unknown, previous?: string): EditDiff | undefined {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const pairs: Array<[string, string]> = [];
  if (typeof a.content === "string" && (a.operation === "write" || a.old_content == null)) pairs.push([previous ?? "", a.content]);
  if (Array.isArray(a.edits)) {
    for (const e of a.edits as Array<Record<string, unknown>>) pairs.push([str(e?.old_content), str(e?.new_content)]);
  } else if (typeof a.old_content === "string" || typeof a.new_content === "string") {
    pairs.push([str(a.old_content), str(a.new_content)]);
  }
  if (!pairs.length) return undefined;
  const out: EditDiff = { added: 0, removed: 0, lines: [], blocks: pairs.map(([, to]) => to) };
  pairs.forEach(([from, to], i) => {
    if (i > 0) out.lines.push({ kind: "gap", text: "⋯" });
    // Both ends on a newline: "intro" last vs "intro\n" mid-text is the same line.
    const nl = (t: string) => (t && !t.endsWith("\n") ? `${t}\n` : t);
    const hunks = computeDiffHunks(nl(from), nl(to), 1);
    hunks.forEach((h, k) => {
      if (k > 0) out.lines.push({ kind: "gap", text: "⋯" });
      for (const l of h.lines) {
        out.lines.push({ kind: l.type, text: l.content, no: l.type === "remove" ? l.oldLineNum : l.newLineNum, block: i });
      }
      out.added += h.addedCount;
      out.removed += h.removedCount;
    });
  });
  return out.added + out.removed > 0 ? out : undefined;
}

/**
 * Where each block of an edit starts in `file` (1-based), or null when its text
 * isn't there (edited again since): line numbers then stay the block's own.
 */
export function locateBlocks(diff: EditDiff, file: string): Array<number | null> {
  return diff.blocks.map((text) => {
    const probe = text.split("\n").find((l) => l.trim()) ?? "";
    if (!probe) return null;
    const at = file.indexOf(text.trim() ? text.trimEnd() : probe);
    const idx = at >= 0 ? at : file.indexOf(probe);
    if (idx < 0) return null;
    const firstLine = file.slice(0, idx).split("\n").length;
    // The block's own numbering starts at its first line, which may sit above the probe.
    const lead = at >= 0 ? 0 : text.split("\n").findIndex((l) => l === probe);
    return Math.max(1, firstLine - Math.max(0, lead));
  });
}

/** "Added 13 lines" / "+12 −2" for a finished edit, in place of "Successfully wrote …". */
function editSummary(d: EditDiff): string {
  if (d.removed === 0) return `Added ${d.added} line${d.added === 1 ? "" : "s"}`;
  if (d.added === 0) return `Removed ${d.removed} line${d.removed === 1 ? "" : "s"}`;
  return `+${d.added} −${d.removed}`;
}

/** The CLI composer's placeholders: `[Image #1]`, `[Pasted text #2 +40 lines]`, `[File a.ts]`. */
const PLACEHOLDER = /\[(?:Image #\d+|Pasted text #\d+[^\]]*|File [^\]]+|Folder [^\]]+)\]/g;
/** The app's stubs for the same things: `<atlarix-text-attachment filename="a.ts" />`. */
const STUB = /<atlarix-([a-z]+)-attachment\b([^>]*?)(?:\/>|>[\s\S]*?<\/atlarix-\1-attachment>)/g;

/** A message's attachments and pastes as chips; the app's stub tags leave the text. */
export function userChips(text: string): { text: string; chips: string[] } {
  const chips: string[] = [];
  const stripped = text.replace(STUB, (_whole, kind: string, attrs: string) => {
    const name = /(?:filename|label|name)="([^"]*)"/.exec(attrs)?.[1] ?? kind;
    chips.push(kind === "image" ? `[Image ${name}]` : `[${name}]`);
    return "";
  });
  for (const m of stripped.matchAll(PLACEHOLDER)) chips.push(m[0]);
  return { text: stripped.trim(), chips };
}

/** A sent message is drawn cut to this many lines before ctrl+o. */
export const MAX_USER_LINES = 6;

/**
 * What the user band shows. Collapsed, the TYPED text only — a paste stays its
 * one-line placeholder (its chips), and a long message is cut to a few lines.
 * ctrl+o (expanded) shows the paste's real text when there was one, else the
 * whole message. Without this a 40-line paste filled the screen (owner, 2026-10-31).
 */
export function userBandText(
  cell: { text: string; full?: string },
  expanded: boolean,
): { text: string; more: number } {
  const whole = cell.full ?? cell.text;
  if (expanded) return { text: whole, more: 0 };
  const lines = cell.text.split("\n");
  if (lines.length <= MAX_USER_LINES) return { text: cell.text, more: 0 };
  return { text: lines.slice(0, MAX_USER_LINES).join("\n"), more: lines.length - MAX_USER_LINES };
}

const QA_LINE = /^\*\*\*Q:\*\*\* ([\s\S]*?) → \*\*\*A:\*\*\* ([\s\S]*)$/;

/** The question/answer pairs in a user message that is nothing but answers, or null. */
export function answerPairs(text: string): Array<{ question: string; answer: string }> | null {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return null;
  const pairs = lines.map((l) => QA_LINE.exec(l.trim()));
  if (pairs.some((m) => !m)) return null;
  return pairs.map((m) => ({ question: m![1]!.trim(), answer: m![2]!.trim() }));
}

/**
 * A `task` call's result is an envelope: `<task id="…" state="running">…</task>`
 * when the sub-agent went to the background, the report inside when it ended.
 * Read it, so the row says what is true (QA saw the raw tag under the row, and
 * the done mark on an agent still at work).
 */
function taskEnvelope(text: string): { state: string; inner: string } | null {
  const m = /^\s*<task\b[^>]*\bstate="([a-z_]+)"[^>]*>\n?([\s\S]*?)\n?<\/task>\s*$/.exec(text);
  return m ? { state: m[1]!, inner: m[2]!.trim() } : null;
}

export function toolLine(part: Extract<AssistantMessagePart, { type: "tool" }>): ToolLine {
  // A bare error code ("file_not_found") says less than the result's own
  // message ("No file at path …"): prefer the message when there is one.
  const codeOnly = !!part.error && /^[a-z][a-z0-9_]*$/.test(part.error.trim()) && !!part.resultText?.trim();
  const r = toolResultText(part.toolName, codeOnly ? part.resultText : (part.error ?? part.resultText));
  const diff =
    part.toolName === "edit_file" && part.status === "success" ? editDiff(part.args, writePrevious(part.callId)) : undefined;
  const env = part.toolName === "task" ? taskEnvelope(r.text) : null;
  // A send_message's own text, for the row that names who it is to and shows
  // what was said, not the "Sent to …" envelope (owner, 2026-10-31: a bare "Message").
  const sent = part.toolName === "send_message" ? sendMessageText(part.args) : null;
  const sentShown = sent?.text && part.status !== "error";
  if (env) {
    const background = env.state === "running" || env.state === "pending";
    const first = firstSentence(env.inner);
    return {
      id: part.id,
      verb: VERBS[part.toolName] ?? part.toolName.replace(/_/g, " "),
      target: toolTarget(part.toolName, part.args, part.resultText),
      // The call returned at once; the agent itself is still working.
      status: background ? "running" : env.state === "error" || env.state === "failed" ? "error" : part.status,
      result: part.resultText,
      error: part.error,
      output: env.inner || undefined,
      summary: background ? "running in the background" : first,
    };
  }
  return {
    diff,
    id: part.id,
    verb: VERBS[part.toolName] ?? part.toolName.replace(/_/g, " "),
    target: toolTarget(part.toolName, part.args, part.resultText),
    // A no-op (compress_context with nothing to compact) says success:false but
    // did what it should: done, not ✕ (A4; the app's cards settle it the same way).
    status: part.status === "error" && noopSummary(part.toolName, part.resultText) ? "success" : part.status,
    result: part.resultText,
    error: part.error,
    // A plan the agent wrote: the plan itself, to read and correct where it was
    // written, not only in the card above (owner: "why can't I see the plan?").
    output:
      sentShown
        ? sent.text
        : part.toolName === "plan" && str((part.args as Record<string, unknown>)?.operation) === "write" && str((part.args as Record<string, unknown>)?.content).trim()
          ? str((part.args as Record<string, unknown>)?.content).trim()
          : shownOutput(part.toolName, r.text),
    summary: part.status === "running" ? undefined : diff ? editSummary(diff) : sentShown ? sent.text.split("\n")[0] : summarize(part.toolName, r),
  };
}

/**
 * The output a row shows under a command (the TUI prints it, not the summary):
 * without the "=== STDOUT ===" plumbing, and none for a command sent to the
 * background, whose "output" is the note for the model (QA #13, #37a: fixed in
 * the summary, still printed from here).
 */
function shownOutput(toolName: string, text: string): string | undefined {
  if (!text) return undefined;
  if (toolName !== "run_command") return text;
  if (/^\s*(Background command started|Still running after \d+s — moved to the background)/.test(text)) return undefined;
  const out = text
    .split("\n")
    .filter((l) => !/^=== (STDOUT|STDERR) ===$/.test(l.trim()))
    .join("\n")
    .trim();
  return out || undefined;
}

/**
 * Cells for the whole conversation. Ids are stable across chunks, so a renderer
 * can key on them. `streaming` says a turn is live: the LAST assistant message
 * is then still being written, and a call with no result yet is running (once
 * the turn is over, the desktop's parser reads the same call as failed).
 */
/**
 * The cells of each message already turned into cells, by id and role. A turn
 * streams dozens of chunks a second and each one rebuilt EVERY message, so a
 * long session (hundreds of tool calls, a 1,400-line command output) spent most
 * of its time re-parsing finished messages, and the screen stopped keeping up
 * with the keyboard. Only the message still being written is parsed again; a
 * finished one is reused while its content is unchanged (an edit or resume
 * replaces the content, so it misses). Reused cells are the same objects, so
 * the renderer can skip them too.
 */
const cellCache = new Map<string, { content: string; model: string | null; cells: Cell[] }>();
const CELL_CACHE_MAX = 2_000;

/** The sources tag, whole or still arriving at the end of a streamed reply. */
const SOURCES_TAG = /<atlarix-sources>[\s\S]*?(?:<\/atlarix-sources>|$)/g;

/** "Sources" and one link per source, its site after it when the title does not say. */
function sourcesText(sources: ReadonlyArray<{ url: string; title?: string }>): string {
  const lines = sources.map((s) => {
    let host = "";
    try {
      host = new URL(s.url).hostname.replace(/^www\./, "");
    } catch {
      /* not a URL we can name */
    }
    const title = (s.title || host || s.url).replace(/[[\]]/g, "");
    const site = host && !title.toLowerCase().includes(host.toLowerCase()) ? ` · ${host}` : "";
    return `- [${title}](${s.url})${site}`;
  });
  return `**Sources**\n${lines.join("\n")}`;
}

function messageCells(m: ChatMessageLike, live: boolean): Cell[] {
  const key = `${m.role}:${m.id}`;
  if (!live) {
    const hit = cellCache.get(key);
    if (hit && hit.content === m.content && hit.model === (m.modelContent ?? null)) return hit.cells;
  }
  const cells: Cell[] = [];
  const base = String(m.id);
  // A message from another Atlarix session: who sent it, then what it said —
  // never drawn as the user's own band (lib/peers).
  const peerSegments = m.role === "user" ? splitPeerMessages(m.content) : null;
  if (peerSegments) {
    peerSegments.forEach((seg, i) => {
      if (seg.kind === "peer") {
        // One row, like Claude Code's: "Message from X (CLI): <its text…>",
        // the whole text on ctrl+o. The text is IN the row: a cut first line
        // under it read as "a blank thing" (owner, 2026-11-05). Never the
        // user's band, never the assistant's ◆: both read as someone else's words.
        const where = peerSurfaceLabel(seg.surface);
        const text = seg.text.trim();
        const from = seg.from || "another session";
        const { text: preview, more } = peerPreview(text);
        cells.push({
          kind: "tool",
          id: `${base}:p${i}`,
          tool: {
            id: `${base}:p${i}`,
            verb: "Message",
            target: `from ${from} (${where})`,
            status: "success",
            output: text,
            peer: { from, surface: seg.surface, preview, more },
          },
        });
      } else if (seg.text.trim()) {
        cells.push({ kind: "user", id: `${base}:pu${i}`, text: seg.text.trim() });
      }
    });
  } else if (m.role === "user") {
    const pairs = answerPairs(m.content);
    if (pairs) cells.push({ kind: "answers", id: `${base}:u`, pairs });
    else if (m.content.trim() === BUILD_FROM_PLAN_PROMPT) {
      // "Build it" sends this for you: a marker, not your words to edit or undo,
      // and its "Plan panel" is the desktop's (QA: it read as typed on reopen).
      cells.push({ kind: "notice", id: `${base}:build`, level: "info", text: "▸ Build it" });
    } else if (m.content.trim()) {
      const { text, chips } = userChips(m.content);
      // A paste: show what was pasted (the placeholder alone said nothing).
      // (Without the harness's reminders: project memory rides the same row.)
      const full = /\[Pasted text #\d+/.test(m.content) && m.modelContent && m.modelContent !== m.content ? stripSystemReminders(m.modelContent) : undefined;
      cells.push({ kind: "user", id: `${base}:u`, text: text || chips.join(" "), ...(chips.length ? { chips } : {}), ...(full ? { full } : {}) });
    }
  } else if (m.role === "assistant") {
    // The pending-questions marker is for the desktop's card; the CLI asks them in a dialog.
    const withSources = stripQuestionsArtifactForDisplay(m.content);
    // A provider's own web search ends the reply with `<atlarix-sources>[…]`,
    // which the desktop draws as citation chips; drawn as text it was a wall of
    // JSON under the answer (owner, 2026-10-19). Listed as links instead, and a
    // tag still arriving is hidden until it is whole.
    const sources = extractInlineSourcesFromContent(withSources);
    const content = withSources.replace(SOURCES_TAG, "").replace(/\s+$/, "");
    parseAssistantMessageParts(content, live).forEach((p, i) => {
      const id = `${base}:${i}`;
      if (p.type === "markdown") {
        if (p.content.trim()) cells.push({ kind: "markdown", id, text: p.content.trim() });
      } else if (p.type === "thought") {
        if (p.content.trim()) cells.push({ kind: "thought", id, text: p.content.trim() });
      } else if (p.type === "tool") {
        cells.push({ kind: "tool", id: `${base}:t:${p.id}`, tool: toolLine(p) });
      }
    });
    if (sources.length) cells.push({ kind: "markdown", id: `${base}:sources`, text: sourcesText(sources) });
  }
  if (!live) {
    if (cellCache.size >= CELL_CACHE_MAX) cellCache.delete(cellCache.keys().next().value!);
    cellCache.set(key, { content: m.content, model: m.modelContent ?? null, cells });
  }
  return cells;
}

export function toCells(
  messages: readonly ChatMessageLike[],
  { streaming = false }: { streaming?: boolean } = {},
): Cell[] {
  const cells: Cell[] = [];
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });
  for (const [index, m] of messages.entries()) {
    cells.push(...messageCells(m, streaming && index === lastAssistant));
  }
  return cells;
}

/** The first `n` lines of a tool result, for the collapsed preview. */
export function previewLines(text: string | undefined, n: number): { lines: string[]; more: number } {
  const all = (text ?? "").replace(/\s+$/, "").split("\n");
  return { lines: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/**
 * After an interrupt (Esc): calls in those messages that never finished read as
 * "interrupted", not "failed", and a note marks where the turn stopped.
 */
/** The line under a reply stopped with ctrl+s: you already said what comes next. */
export const SENT_NOW_LINE = "Stopped to send your queued messages.";

export function markInterrupted(
  cells: Cell[],
  interruptedMessageIds: ReadonlySet<string>,
  /** Stopped by send now (ctrl+s): no "what to do instead" hint. */
  sentNowIds: ReadonlySet<string> = new Set(),
): Cell[] {
  if (interruptedMessageIds.size === 0) return cells;
  const out: Cell[] = [];
  cells.forEach((c, i) => {
    const msg = c.id.split(":")[0]!;
    const hit = interruptedMessageIds.has(msg);
    // No result and no error: it never finished. (The parser labels such a call
    // "success" once the turn is over; in an interrupted turn it was cut off.)
    if (hit && c.kind === "tool" && !c.tool.result && !c.tool.error) {
      out.push({ ...c, tool: { ...c.tool, status: "interrupted" } });
    } else {
      out.push(c);
    }
    const next = cells[i + 1];
    if (hit && (!next || next.id.split(":")[0] !== msg)) {
      out.push({ kind: "notice", id: `${msg}:interrupted`, level: "info", text: sentNowIds.has(msg) ? SENT_NOW_LINE : "Interrupted. Tell Atlarix what to do instead." });
    }
  });
  return out;
}

/** A steer the agent took mid-turn, and where in its answer it took it. */
export interface SteerAnchor {
  /** The user message (the steer) as it appears in the message list. */
  messageId: string;
  /** The assistant message it arrived during, and how much of it existed then. */
  assistantId: string;
  offset: number;
}

/**
 * Put each delivered steer where it happened: inside the answer it interrupted,
 * after the parts that were already written (the desktop draws it above the
 * whole answer; Codex draws it inline, which is what the order of events was).
 */
export function placeSteers(
  messages: readonly ChatMessageLike[],
  anchors: ReadonlyMap<string, SteerAnchor>,
  opts: { streaming?: boolean } = {},
): Cell[] {
  const others = messages.filter((m) => !anchors.has(String(m.id)));
  const cells = toCells(others, opts);
  const order = new Map(messages.map((m, i) => [String(m.id), i]));
  for (const m of messages) {
    const a = anchors.get(String(m.id));
    if (!a) continue;
    const answer = messages.find((x) => String(x.id) === a.assistantId);
    const firstIdx = cells.findIndex((c) => c.id.startsWith(`${a.assistantId}:`));
    // The message as it normally draws: a steer is a user band, a peer message a
    // "Message from X" tool line (lib/peers: never the user's own band).
    const rendered = messageCells(m, false);
    if (!answer || firstIdx < 0) {
      // The answer it came during shows nothing (stopped or failed before any
      // output): in its own place, before anything sent after it. Appended,
      // it sank below later turns (QA).
      const mine = order.get(String(m.id)) ?? Infinity;
      const at = cells.findIndex((c) => (order.get(c.id.split(":")[0]!) ?? -1) > mine);
      if (at < 0) cells.push(...rendered);
      else cells.splice(at, 0, ...rendered);
      continue;
    }
    const before = toCells([{ ...answer, content: answer.content.slice(0, a.offset) }], { streaming: true }).length;
    cells.splice(firstIdx + before, 0, ...rendered);
  }
  return cells;
}

/**
 * Turn delivered steers and peer messages into anchors (pure, for tests).
 *
 * A user message that is a steer (`steerTexts`) or a peer message is anchored
 * against the answer `taken` recorded when it was delivered, and only then is
 * it marked seen. A steer whose row lands after the growing answer (a long
 * single turn) is left un-seen so a later pass anchors it instead of sinking
 * to the bottom of the transcript (owner, 2026-10-31). `taken` and `seen` are
 * mutated; the remaining `steerTexts` and the anchors are returned.
 */
export function collectAnchors(opts: {
  messages: readonly ChatMessageLike[];
  steerTexts: readonly string[];
  taken: Map<string, { assistantId: string; offset: number }>;
  seen: Set<string>;
}): { anchors: Map<string, SteerAnchor>; steerTexts: string[] } {
  const anchors = new Map<string, SteerAnchor>();
  const nextTexts = opts.steerTexts.slice();
  for (const m of opts.messages) {
    if (m.role !== "user") continue;
    const id = String(m.id);
    if (opts.seen.has(id)) continue;
    const text = m.content.trim();
    const k = nextTexts.indexOf(text);
    const isPeer = splitPeerMessages(m.content)?.some((s) => s.kind === "peer") ?? false;
    if (k < 0 && !isPeer) {
      // A real user message: nothing to anchor.
      opts.seen.add(id);
      continue;
    }
    const taken = opts.taken.get(text);
    if (!taken) continue; // not delivered yet; a later pass records it
    opts.seen.add(id);
    if (k >= 0) nextTexts.splice(k, 1);
    opts.taken.delete(text);
    const answer = opts.messages.find((x) => String(x.id) === taken.assistantId);
    const offset = answer ? Math.min(taken.offset, answer.content.length) : taken.offset;
    anchors.set(id, { messageId: id, assistantId: taken.assistantId, offset });
  }
  return { anchors, steerTexts: nextTexts };
}

/**
 * The replies a reopened chat shows as interrupted: the saved rows marked so.
 * A stopped reply's row keeps its text without the stop mark (the mark is in
 * what the model is sent), so `-c` drew the partial reply with no note (QA
 * 15.7.1 #11b). Ids are the rows' 1-based positions, as the CLI numbers them.
 */
export function interruptedRowIds(
  rows: ReadonlyArray<{ role: string; status?: string | null }>,
): string[] {
  return rows.flatMap((m, i) =>
    m.role === "assistant" && m.status === "interrupted" ? [String(i + 1)] : [],
  );
}

/** What the agent appends to an answer it stopped (build-branch.ts). */
export const CANCEL_MARK = "[Response cancelled by user]";

/**
 * After a cancel the agent keeps TWO messages for the same answer: the live
 * one, and a finished copy (a new id) holding the same text plus CANCEL_MARK.
 * Drawn as-is, the call appeared twice, the second time as if it had finished.
 * Keep the copy, carry the "interrupted" mark over to it, and drop the marker
 * text: the CLI shows its own "Interrupted" note.
 */
export function collapseCancelled(
  messages: readonly ChatMessageLike[],
  interrupted: Set<string>,
): ChatMessageLike[] {
  const out: ChatMessageLike[] = [];
  for (const m of messages) {
    const prev = out.at(-1);
    const body = m.content.includes(CANCEL_MARK) ? m.content.replace(CANCEL_MARK, "").trimEnd() : m.content;
    if (
      m.role === "assistant" &&
      prev?.role === "assistant" &&
      m.content.includes(CANCEL_MARK) &&
      body.startsWith(prev.content.trimEnd())
    ) {
      out.pop();
      if (interrupted.has(String(prev.id))) interrupted.add(String(m.id));
    }
    // Stopped before any output: the record is the mark alone, which draws
    // nothing. The "Interrupted" note goes under your message instead (QA
    // 15.7.1 #2, a reopened chat showed the stopped prompt with nothing under it).
    if (m.role === "assistant" && m.content.includes(CANCEL_MARK) && !body.trim() && out.at(-1)?.role === "user") {
      interrupted.add(String(out.at(-1)!.id));
      continue;
    }
    out.push(body === m.content ? m : { ...m, content: body });
  }
  return out;
}
