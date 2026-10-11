/**
 * The CLI's transcript (`SessionState.cells`) as ACP `session/update`s.
 *
 * The session rebuilds its cells on every chunk; an editor wants deltas. So this
 * remembers what each cell id last looked like and emits only the difference:
 * the new tail of a message or a thought, a tool call the first time it shows up
 * and an update when its status or output changes. Pure (no I/O), so the edge
 * cases are unit-tested without an editor.
 */
import type { SessionUpdate, ToolCallContent, ToolKind, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { Cell, EditDiff, ToolLine } from "../agent/transcript";

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

function toolContent(t: ToolLine, name: string): ToolCallContent[] {
  const out: ToolCallContent[] = [];
  if (t.diff && name === "edit_file" && t.target) out.push(snippetDiff(t.target, t.diff));
  const body = t.status === "error" || t.status === "interrupted" ? (t.error ?? t.output) : t.output;
  if (body?.trim()) out.push(text(body));
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
export function diffUpdates(cells: readonly Cell[], emitted: Emitted, opts: { replay?: boolean; ids?: boolean } = {}): SessionUpdate[] {
  const out: SessionUpdate[] = [];
  for (const c of cells) {
    const k = key(c);
    const before = emitted.get(k);
    if (c.kind === "markdown" || c.kind === "thought") {
      const prev = before ?? "";
      if (c.text === prev) continue;
      emitted.set(k, c.text);
      // A rewrite rather than a growth (a cancel collapsing the tail) cannot be
      // taken back from an editor that already drew it: send nothing for it.
      if (!c.text.startsWith(prev)) continue;
      const delta = c.text.slice(prev.length);
      if (!delta) continue;
      out.push({
        sessionUpdate: c.kind === "markdown" ? "agent_message_chunk" : "agent_thought_chunk",
        content: { type: "text", text: delta },
      });
    } else if (c.kind === "tool") {
      const t = c.tool;
      const name = toolNameFromId(c.id);
      const sig = `${t.status}|${t.output?.length ?? 0}|${t.error ?? ""}|${t.diff ? t.diff.added + t.diff.removed : 0}`;
      if (before === sig) continue;
      emitted.set(k, sig);
      const content = toolContent(t, name);
      if (before === undefined) {
        // A message from another Atlarix session (transcript.ts draws it as a
        // "Message from X (app)" step): marked so Atlarix's extension shows it
        // as a message card; other editors show the step as is.
        const peer = t.verb === "Message" && /:p\d+$/.test(c.id) ? { _meta: { atlarix: { peer: { from: t.target?.replace(/^from /, "") ?? "" } } } } : {};
        out.push({
          sessionUpdate: "tool_call",
          toolCallId: c.id,
          title: toolTitle(t),
          kind: toolKind(name),
          status: status(t.status),
          ...peer,
          ...(t.target && /[/\\.]/.test(t.target) && toolKind(name) !== "execute" ? { locations: [{ path: t.target }] } : {}),
          ...(content.length ? { content } : {}),
        });
      } else {
        out.push({
          sessionUpdate: "tool_call_update",
          toolCallId: c.id,
          status: status(t.status),
          ...(content.length ? { content } : {}),
        });
      }
    } else if (c.kind === "notice") {
      if (before !== undefined) continue;
      emitted.set(k, c.text);
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
