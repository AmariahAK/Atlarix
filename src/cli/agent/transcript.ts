/**
 * The CLI transcript as data: the agent's messages (the same array the desktop
 * renders, sent whole on every `chat:response:chunk`) turned into cells.
 *
 * Assistant text is split by the desktop's own parser (parseAssistantMessageParts),
 * so tool calls, thinking and prose come apart exactly as they do in the app.
 * Pure: the TUI renders cells; src/__tests__/cli-transcript.test.ts pins the rules.
 */
import { plainStepText } from "@/lib/tasks/plan-checklist";
import { displayTitle } from "@/shared/mcp-catalog";
import { BUILD_FROM_PLAN_PROMPT } from "@/lib/work-mode";
import { computeDiffHunks } from "@/lib/diff/compose-hunks";
import { peerSurfaceLabel, splitPeerMessages } from "@/lib/peers/peer-message";
import {
  parseAssistantMessageParts,
  type AssistantMessagePart,
} from "@/lib/chat/assistant-message-parts";
import { stripQuestionsArtifactForDisplay } from "@/lib/chat/ask-user-artifacts";

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
  const st = p.status === "running" ? "running" : p.status === "error" || p.status === "failed" ? "error" : "success";
  const raw = typeof p.resultText === "string" ? p.resultText : undefined;
  const r = toolResultText(name, raw);
  return {
    id: String(p.id ?? `${name}-${Math.random()}`),
    verb: VERBS[name] ?? name.replace(/_/g, " "),
    target: toolTarget(name, p.toolArgs) || (typeof p.detail === "string" ? p.detail.split("\n")[0]!.slice(0, 80) : ""),
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
  transcribe_audio: "Transcribe",
  list_sessions: "Sessions",
  send_message: "Message",
  list_attachments: "Attachments",
  tool_help: "Tool help",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The one thing worth naming about a call, from its arguments. */
export function toolTarget(toolName: string, args: unknown): string {
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
  // The result can arrive as its JSON text (QA: `{"content":[…],"isError":false}` on the row).
  if (typeof v === "string" && /^\s*\{/.test(v) && depth <= 4) {
    try {
      return mcpContentText(JSON.parse(v), depth + 1);
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
 * What an edit_file call changed, from its own arguments: a write is all
 * additions; a replace (or each of its `edits`) is the old text against the
 * new. Line numbers are the snippet's, not the file's, so none are shown.
 */
export function editDiff(args: unknown): EditDiff | undefined {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const pairs: Array<[string, string]> = [];
  if (typeof a.content === "string" && (a.operation === "write" || a.old_content == null)) pairs.push(["", a.content]);
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
  const diff = part.toolName === "edit_file" && part.status === "success" ? editDiff(part.args) : undefined;
  const env = part.toolName === "task" ? taskEnvelope(r.text) : null;
  if (env) {
    const background = env.state === "running" || env.state === "pending";
    const first = firstSentence(env.inner);
    return {
      id: part.id,
      verb: VERBS[part.toolName] ?? part.toolName.replace(/_/g, " "),
      target: toolTarget(part.toolName, part.args),
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
    target: toolTarget(part.toolName, part.args),
    status: part.status,
    result: part.resultText,
    error: part.error,
    // A plan the agent wrote: the plan itself, to read and correct where it was
    // written, not only in the card above (owner: "why can't I see the plan?").
    output:
      part.toolName === "plan" && str((part.args as Record<string, unknown>)?.operation) === "write" && str((part.args as Record<string, unknown>)?.content).trim()
        ? str((part.args as Record<string, unknown>)?.content).trim()
        : shownOutput(part.toolName, r.text),
    summary: part.status === "running" ? undefined : diff ? editSummary(diff) : summarize(part.toolName, r),
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
        // Drawn like a tool step: "Message from X (app)", its first line under
        // it, the whole text on ctrl+o. Never the user's band, never the
        // assistant's ◆, both of which read as someone else's words.
        const where = peerSurfaceLabel(seg.surface);
        const text = seg.text.trim();
        const first = text.split("\n")[0] ?? "";
        cells.push({
          kind: "tool",
          id: `${base}:p${i}`,
          tool: {
            id: `${base}:p${i}`,
            // A contributor: another of your Atlarix sessions, as Claude Code
            // calls them (owner), named so it never reads as you.
            verb: "Message",
            target: `from contributor ${seg.from || "another session"} (${where})`,
            status: "success",
            summary: first.length > 160 ? `${first.slice(0, 159)}…` : first,
            output: text,
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
      const full = /\[Pasted text #\d+/.test(m.content) && m.modelContent && m.modelContent !== m.content ? m.modelContent.trim() : undefined;
      cells.push({ kind: "user", id: `${base}:u`, text: text || chips.join(" "), ...(chips.length ? { chips } : {}), ...(full ? { full } : {}) });
    }
  } else if (m.role === "assistant") {
    // The pending-questions marker is for the desktop's card; the CLI asks them in a dialog.
    const content = stripQuestionsArtifactForDisplay(m.content);
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
export function markInterrupted(cells: Cell[], interruptedMessageIds: ReadonlySet<string>): Cell[] {
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
      out.push({ kind: "notice", id: `${msg}:interrupted`, level: "info", text: "Interrupted. Tell Atlarix what to do instead." });
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
    const cell: Cell = { kind: "user", id: `${String(m.id)}:u`, text: m.content.trim() };
    if (!answer || firstIdx < 0) {
      // The answer it came during shows nothing (stopped or failed before any
      // output): in its own place, before anything sent after it. Appended,
      // it sank below later turns (QA).
      const mine = order.get(String(m.id)) ?? Infinity;
      const at = cells.findIndex((c) => (order.get(c.id.split(":")[0]!) ?? -1) > mine);
      if (at < 0) cells.push(cell);
      else cells.splice(at, 0, cell);
      continue;
    }
    const before = toCells([{ ...answer, content: answer.content.slice(0, a.offset) }], { streaming: true }).length;
    cells.splice(firstIdx + before, 0, cell);
  }
  return cells;
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
    out.push(body === m.content ? m : { ...m, content: body });
  }
  return out;
}
