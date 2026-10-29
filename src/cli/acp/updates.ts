/**
 * The CLI's transcript (`SessionState.cells`) as ACP `session/update`s.
 *
 * The session rebuilds its cells on every chunk; an editor wants deltas. So this
 * remembers what each cell id last looked like and emits only the difference:
 * the new tail of a message or a thought, a tool call the first time it shows up
 * and an update when its status or output changes. Pure (no I/O), so the edge
 * cases are unit-tested without an editor.
 */
import { ZENITH_OFFER_MARKER } from "@/shared/billing_copy";
import type { SessionUpdate, ToolCallContent, ToolKind, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { Cell, EditDiff, ToolLine } from "../agent/transcript";
import { glyph } from "../tui/glyphs";
import { urlsIn } from "@/lib/text/urls";

/**
 * What each cell looked like when last sent, keyed by kind AND id: one id can
 * change kind. While a model thinks, the live text parses as a thought at part
 * 0; the finished message, without its thinking, is markdown at that same part.
 * Keyed by id alone, the answer read as a rewrite of the thought and was never
 * sent (seen live in Zed on GLM 5.3: only "Thinking", no reply).
 */
export type Emitted = Map<string, string>;

const key = (c: Cell): string => `${c.kind}:${c.id}`;

/** `<message>:t:<tool>_<n>` → `<tool>`; empty for cells that are not tool calls. */
export function toolNameFromId(id: string): string {
  const m = /:t:(.+?)(?:_\d+)?$/.exec(id);
  return m?.[1] ?? "";
}

export function toolKind(name: string): ToolKind {
  if (name === "read_file" || name === "list_files") return "read";
  if (name === "edit_file") return "edit";
  if (name === "delete_file") return "delete";
  if (name === "rename_file") return "move";
  if (name === "grep" || name === "glob" || name === "find_files") return "search";
  if (name === "run_command") return "execute";
  if (name === "read_url" || name === "web_search" || name === "web_fetch") return "fetch";
  if (name === "task") return "think";
  return "other";
}

function status(s: ToolLine["status"]): ToolCallStatus {
  return s === "running" ? "in_progress" : s === "success" ? "completed" : "failed";
}

/**
 * An edit's changes as ACP's diff block: the snippet before and after. The CLI
 * keeps the edit's own old/new text (not the whole file), which is what the
 * editor draws in the tool call; the full-file view comes with the approval.
 */
export function snippetDiff(path: string, d: EditDiff): ToolCallContent {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const l of d.lines) {
    if (l.kind === "gap") {
      oldLines.push("⋯");
      newLines.push("⋯");
    } else if (l.kind === "remove") oldLines.push(l.text);
    else if (l.kind === "add") newLines.push(l.text);
    else {
      oldLines.push(l.text);
      newLines.push(l.text);
    }
  }
  return { type: "diff", path, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

function text(t: string): ToolCallContent {
  return { type: "content", content: { type: "text", text: t } };
}

/** Tokens as people read them: 950, 12.4k, 1.2M. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * A sub-agent as text any editor can draw: what it is doing, each of its own
 * calls, what it has used, then its report. ACP has no notion of a sub-agent,
 * so the `task` call's body is where its work becomes visible.
 */
function subagentText(t: ToolLine): string {
  const lines: string[] = [];
  if (t.status === "running" && t.progress?.trim()) lines.push(t.progress.trim());
  for (const c of t.children ?? []) {
    lines.push(`${glyph.tool[c.status] ?? glyph.tool.success} ${c.target ? `${c.verb} ${c.target}` : c.verb}`);
  }
  const n = t.children?.length ?? 0;
  const used = [n ? `${n} tool${n === 1 ? "" : "s"}` : "", t.agent?.tokens ? `${compactTokens(t.agent.tokens)} tokens` : ""].filter(Boolean);
  if (used.length) lines.push(used.join(" · "));
  const report = t.status === "running" ? "" : agentReport(t).trim();
  if (report) lines.push("", report);
  return lines.join("\n");
}

/**
 * What the agent itself reported (its answer, or why it failed) before the call's
 * own output: for a background agent that output is the START envelope
 * ("Background sub-agent started…"), which hid a failed agent's reason (QA #50).
 */
function agentReport(t: ToolLine): string {
  return t.agent?.report?.trim() || t.error || t.output || "";
}

/** What Atlarix's own extension draws a sub-agent from; other editors ignore `_meta`. */
function subagentMeta(t: ToolLine): Record<string, unknown> {
  return {
    _meta: {
      atlarix: {
        subagent: {
          // The task's own description ("Read README first line"), not the
          // generic agent name ("Sub-agent: Explore").
          label: t.target || t.agent?.label || "Sub-agent",
          status: t.status,
          progress: t.status === "running" ? (t.progress ?? null) : null,
          tokens: t.agent?.tokens ?? null,
          startedAt: t.agent?.startedAt ?? null,
          tools: (t.children ?? []).map((c) => ({ verb: c.verb, target: c.target, status: c.status })),
          report: t.status === "running" ? null : agentReport(t) || null,
        },
      },
    },
  };
}

function toolContent(t: ToolLine, name: string): ToolCallContent[] {
  if (name === "task") {
    const body = subagentText(t);
    return body ? [text(body)] : [];
  }
  const out: ToolCallContent[] = [];
  if (t.diff && name === "edit_file" && t.target) out.push(snippetDiff(t.target, t.diff));
  // A command sent to the background returns a note for the model (its job id,
  // "do not poll"); the card says what happened instead (QA #28, CLI #13).
  if (name === "run_command" && t.summary === "started in the background") return [text("Started in the background.")];
  const body = t.status === "error" || t.status === "interrupted" ? (t.error ?? t.output) : t.output;
  if (body?.trim()) out.push(text(body));
  // A step the user stopped has no output of its own; an editor otherwise
  // shows a failed step with no reason (ai-26).
  else if (t.status === "interrupted") out.push(text("Stopped."));
  // A dev server's address and the like, as links the editor can open: command
  // output is plain text, and an editor shows it verbatim.
  if (name === "run_command" && body) {
    for (const uri of urlsIn(body)) out.push({ type: "content", content: { type: "resource_link", uri, name: uri } });
  }
  return out;
}

/** The tool's title in the editor: the same "verb target" the terminal shows. */
export function toolTitle(t: ToolLine): string {
  return t.target ? `${t.verb} ${t.target}` : t.verb;
}

/** The stored message behind your own message's cell (`<id>:u`), or null for one not saved yet. */
function userMessageId(cellId: string): number | null {
  const m = /^(\d+):u$/.exec(cellId);
  return m ? Number(m[1]) : null;
}

/**
 * The updates that bring the editor from what it was sent (`emitted`) to
 * `cells`, and `emitted` updated to match. `replay` (session/load) also sends
 * the user's own messages, which a live editor already shows.
 *
 * `ids` (Atlarix's own extension): your messages carry their stored id, so the
 * extension can offer going back to one. Live, where the editor already drew
 * the message, it comes as an `echo` that names the id and draws nothing.
 */
/**
 * A reply or thought already sent under a key this transcript no longer has.
 *
 * Text cells are keyed by their part's position in the message
 * (`<message>:<n>`), and the saved message can lay its parts out differently
 * from the live one (a tool part added or dropped at the end). The same text
 * then shows up under a new key, and was sent again in full: the editor drew
 * the reply twice. Taking over the old key's text, when the new text continues
 * it, sends only what is actually new.
 */
function movedText(c: Cell & { kind: "markdown" | "thought" }, emitted: Emitted, present: ReadonlySet<string>): string | undefined {
  const base = c.id.slice(0, c.id.lastIndexOf(":"));
  const prefix = `${c.kind}:${base}:`;
  let best: { k: string; text: string } | null = null;
  for (const [k, text] of emitted) {
    if (!k.startsWith(prefix) || present.has(k) || !text || !c.text.startsWith(text)) continue;
    if (!best || text.length > best.text.length) best = { k, text };
  }
  if (!best) return undefined;
  emitted.delete(best.k);
  return best.text;
}

export function diffUpdates(cells: readonly Cell[], emitted: Emitted, opts: { replay?: boolean; ids?: boolean } = {}): SessionUpdate[] {
  const out: SessionUpdate[] = [];
  const present = new Set(cells.map(key));
  for (const [i, c] of cells.entries()) {
    const k = key(c);
    const before = emitted.get(k);
    if (c.kind === "markdown" || c.kind === "thought") {
      const moved = before === undefined ? movedText(c, emitted, present) : undefined;
      if (moved !== undefined) emitted.set(k, moved);
      const prev = before ?? moved ?? "";
      if (c.text === prev) continue;
      emitted.set(k, c.text);
      // A rewrite rather than a growth (a cancel collapsing the tail) cannot be
      // taken back from an editor that already drew it: send nothing for it.
      if (!c.text.startsWith(prev)) continue;
      const delta = c.text.slice(prev.length);
      if (!delta) continue;
      // A message straight after another (the Sources list after the reply) is
      // the same stream to the editor: without a break it read
      // "Here is the answer.**Sources**" (QA E3).
      const apart = !prev && c.kind === "markdown" && cells[i - 1]?.kind === "markdown";
      out.push({
        sessionUpdate: c.kind === "markdown" ? "agent_message_chunk" : "agent_thought_chunk",
        content: { type: "text", text: apart ? `\n\n${delta}` : delta },
      });
    } else if (c.kind === "tool") {
      const t = c.tool;
      const name = toolNameFromId(c.id);
      // A sub-agent changes while its call stays "running": its own calls, what it
      // says it is doing, and (in steps of 1k, not every token) what it has used.
      const sub =
        name === "task"
          ? `|${(t.children ?? []).map((ch) => ch.status[0]).join("")}|${t.progress ?? ""}|${Math.floor((t.agent?.tokens ?? 0) / 1000)}`
          : "";
      const sig = `${t.status}|${t.output?.length ?? 0}|${t.error ?? ""}|${t.diff ? t.diff.added + t.diff.removed : 0}${sub}`;
      if (before === sig) continue;
      emitted.set(k, sig);
      const content = toolContent(t, name);
      if (before === undefined) {
        // A message from another Atlarix session (transcript.ts draws it as a
        // "Message from X (app)" step): marked so Atlarix's extension shows it
        // as a message card; other editors show the step as is.
        const peer = t.verb === "Message" && /:p\d+$/.test(c.id) ? { _meta: { atlarix: { peer: { from: t.target?.replace(/^from /, "") ?? "" } } } } : {};
        // A written plan: Atlarix's extension shows it under the step, to read.
        const planBody = name === "plan" && /^write\b/.test(t.target ?? "") ? { _meta: { atlarix: { planBody: true } } } : {};
        out.push({
          sessionUpdate: "tool_call",
          toolCallId: c.id,
          title: toolTitle(t),
          kind: toolKind(name),
          status: status(t.status),
          ...peer,
          ...planBody,
          ...(name === "task" ? subagentMeta(t) : {}),
          ...(t.target && /[/\\.]/.test(t.target) && toolKind(name) !== "execute" ? { locations: [{ path: t.target }] } : {}),
          ...(content.length ? { content } : {}),
        });
      } else {
        out.push({
          sessionUpdate: "tool_call_update",
          toolCallId: c.id,
          status: status(t.status),
          ...(name === "task" ? subagentMeta(t) : {}),
          ...(content.length ? { content } : {}),
        });
      }
    } else if (c.kind === "notice") {
      if (before !== undefined) continue;
      emitted.set(k, c.text);
      // What woke the agent ("◇ Map src/mini finished · 72s"): a finished step,
      // which every editor draws, so a turn it did not ask for has its reason.
      // "Build it" (a plan's build turn): the same kind of marker, in every editor.
      if (c.id.endsWith(":build")) {
        out.push({ sessionUpdate: "tool_call", toolCallId: c.id, title: c.text.replace(/^▸\s*/, ""), kind: "other", status: "completed" });
        continue;
      }
      // Who changed this session's mode, model or plan ("◇ Mode set to Review
      // by Rix. From the next turn.", items 9 and 11): the same finished step,
      // in the panel and every other editor (QA E5, E7).
      if (c.id.startsWith("wake:") || c.id.startsWith("peer-settings:")) {
        out.push({
          sessionUpdate: "tool_call",
          toolCallId: c.id,
          title: c.text.replace(/^◇\s*/, ""),
          kind: "other",
          status: "completed",
        });
        continue;
      }
      // What you just approved ("✓ You approved Atlarix to run `npm test` this
      // time"): a finished step, so it never runs into the reply that follows.
      if (c.id.startsWith("approved:")) {
        out.push({ sessionUpdate: "tool_call", toolCallId: c.id, title: c.text.replace(/^✓\s*/, ""), kind: "other", status: "completed" });
        continue;
      }
      // A turn's error kept in the CLI transcript once the next turn starts
      // (session.ts turnNotices): the editor showed it when that turn failed.
      // Sent again it landed in the NEXT turn, beside its "Interrupted" (QA).
      // Except the Zenith offer, which is made once, at the end of its own turn.
      if (c.id.includes(":turn-notice") && c.text.includes(ZENITH_OFFER_MARKER)) {
        const text = c.text.replace(/^◇\s*/, "").replace("/model Atlarix Zenith", "Pick it in the model list");
        out.push({ sessionUpdate: "tool_call", toolCallId: c.id, title: text, kind: "other", status: "completed" });
        continue;
      }
      if (c.id.includes(":turn-notice")) continue;
      if (c.level === "error") {
        out.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${c.text}` } });
      }
    } else if (c.kind === "user" || c.kind === "answers") {
      if (before !== undefined) continue;
      const t = c.kind === "user" ? c.text : c.pairs.map((p) => `${p.question} → ${p.answer}`).join("\n");
      emitted.set(k, t);
      const messageId = opts.ids && c.kind === "user" ? userMessageId(c.id) : null;
      const meta = messageId != null ? { _meta: { atlarix: { messageId, ...(opts.replay ? {} : { echo: true }) } } } : {};
      if (opts.replay || messageId != null) out.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: t }, ...meta });
    } else {
      emitted.set(k, "");
    }
  }
  return out;
}
