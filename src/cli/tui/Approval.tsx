/** @jsxImportSource @opentui/react */
/**
 * "Run this command?" — the permission prompt, from the agent's own
 * permission-request. Choices map to the approval modes the desktop sends
 * (execute-permission): once, always for this folder, or no.
 */
import { approvalDiff } from "../agent/approval-diff";
import type { PendingApproval } from "../agent/session";
import { approvalChoices, approvalTitle, firstPreview, type ApprovalChoice, automationDetails, outsideWorkspace } from "../agent/approval-choices";
export { approvalChoices, approvalTitle, type ApprovalChoice } from "../agent/approval-choices";
import { useTerminalDimensions } from "@opentui/react";
import { useDiffSegments } from "./diff-highlight";
import { color } from "./theme";

/**
 * A letter for each choice (Codex's y / a / p / esc): y yes, a the first
 * "always", d the folder-wide one, n no. Numbers work too.
 */
export function approvalKey(c: ApprovalChoice): string {
  return { once: "y", always_allow: "a", always_allow_file: "a", always_allow_directory: "d", deny: "n" }[c.mode];
}

/**
 * A dialog diff line is `  12 + code` (an edit) or `+code` (a patch): the
 * number and sign keep the add/remove colour, and only the code is highlighted.
 */
export function splitDiffLine(l: { kind: string; text: string }): { prefix: string; code: string } {
  if (l.kind === "gap") return { prefix: l.text, code: "" };
  // approval-diff.ts writes `${num.padStart(4)} ${mark} ${content}`; a patch line is `+content`.
  const m = /^[\s\d]{4} [+\- ] /.exec(l.text) ?? /^[+\- ]/.exec(l.text);
  return m ? { prefix: m[0], code: l.text.slice(m[0].length) } : { prefix: "", code: l.text };
}

/** Rows a long command shows before ctrl+o. */
export const COMMAND_ROWS = 10;

/**
 * As much of a command as fits in `rows` screen rows at `cols` columns, and how
 * many of its lines are left out. The box never shrinks, so a long command (a PR
 * body in a heredoc) pushed the choices off the bottom of the screen and there
 * was nothing to answer (owner, 2026-10-16).
 */
export function clipCommand(text: string, cols: number, rows: number): { text: string; more: number } {
  const lines = text.split("\n");
  const width = Math.max(1, cols);
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const need = Math.max(1, Math.ceil(lines[i]!.length / width));
    if (used + need > rows) {
      // One line longer than the whole space: its start, cut.
      if (!out.length) return { text: `${lines[i]!.slice(0, Math.max(1, rows * width - 1))}…`, more: lines.length - 1 - i };
      return { text: out.join("\n"), more: lines.length - i };
    }
    out.push(lines[i]!);
    used += need;
  }
  return { text, more: 0 };
}

export function Approval({ approval, selected, expanded = false, workspace }: { approval: PendingApproval; selected: number; expanded?: boolean; workspace?: string }) {
  const p = firstPreview(approval);
  const choices = approvalChoices(approval);
  const shown = p.command ?? p.path ?? p.deniedPath ?? "";
  const { width, height } = useTerminalDimensions();
  // ctrl+o shows the rest, as far as the screen holds with the choices, the
  // prompt box and a few lines of conversation still on it.
  const room = Math.max(3, height - 20 - choices.length);
  const command = p.command ? clipCommand(`$ ${shown}`, width - 8, expanded ? room : Math.min(COMMAND_ROWS, room)) : null;
  // ctrl+o shows the whole change (QA: "… 2 more lines" had no way to see them).
  const diff = approvalDiff(p, expanded ? 400 : 14);
  // The file's language colours the code, as in the transcript's diffs; the
  // sign keeps the add/remove colour (it was all green before).
  const split = (diff?.lines ?? []).map(splitDiffLine);
  const segs = useDiffSegments(p.path, split.map((x) => x.code));
  // Amber is for warnings: a risky command, a write outside the sandbox, a
  // change outside the project. A routine approval is the accent, as in the
  // editor's card (owner's palette, 2026-10-13; QA E7).
  const outside = !p.command && outsideWorkspace(p.path, workspace);
  const risky = !!(p.isDangerous || p.deniedPath || p.systemScope || outside);
  const tone = risky ? color.warn : color.accent;
  const toneBg = risky ? color.warnBg : color.accentBg;
  return (
    <box border borderStyle="rounded" borderColor={tone} backgroundColor={toneBg} padding={1} flexDirection="column" gap={1} flexShrink={0}>
      <text fg={tone}>
        <b>{`△ ${approvalTitle(approval)}`}</b>
      </text>
      {shown ? (
        <box backgroundColor={color.bg} paddingLeft={1} paddingRight={1} flexDirection="column">
          <text fg={color.text}>{command ? command.text : shown}</text>
          {command?.more ? (
            <text fg={color.faint}>{`… ${command.more} more line${command.more === 1 ? "" : "s"}${expanded ? "" : " (ctrl+o)"}`}</text>
          ) : null}
        </box>
      ) : null}
      {p.description ? <text fg={color.textDim}>{p.description.replace(/`/g, "")}</text> : null}
      {outside ? <text fg={color.warn}>{`It's outside this project (${workspace}).`}</text> : null}
      {automationDetails(approval).length ? (
        // One block: the card's gap between every line made it read as a list of separate notes.
        <box flexDirection="column">
          {automationDetails(approval).map((l, i) => (
            <text key={`ad${i}`} fg={color.text}>
              {l}
            </text>
          ))}
        </box>
      ) : null}
      {p.command && p.isDangerous ? (
        // The desktop's own wording (InlinePermissionApprovals.tsx), never a guess
        // such as "can't be undone", which is false for most flagged commands.
        <text fg={color.warn}>{p.dangerExplanation ?? "This command is flagged as risky."}</text>
      ) : null}
      {p.command && !p.isDangerous && p.systemScope ? (
        <text fg={color.textDim}>
          {p.systemScopeExplanation ?? "This changes something outside the current project."} It runs outside the
          project sandbox — only allow if you expect it.
        </text>
      ) : null}
      {diff ? (
        <box flexDirection="column">
          <text fg={color.muted}>
            <span fg={color.accentSoft}>+{diff.added}</span> <span fg={color.error}>−{diff.removed}</span>
          </text>
          {diff.lines.map((l, i) => {
            const sign = l.kind === "add" ? color.accentSoft : l.kind === "remove" ? color.error : color.muted;
            const plain = l.kind === "context" ? color.muted : color.text;
            const { prefix, code } = split[i]!;
            return (
              <text key={i} fg={sign} bg={l.kind === "add" ? color.addBg : l.kind === "remove" ? color.removeBg : undefined}>
                <span fg={l.kind === "gap" ? color.faint : sign}>{prefix}</span>
                {segs?.[i]?.length
                  ? segs[i]!.map((g, k) => (
                      <span key={k} fg={g.fg ?? plain}>
                        {g.italic ? <i>{g.text}</i> : g.text}
                      </span>
                    ))
                  : <span fg={plain}>{code || (prefix ? "" : " ")}</span>}
              </text>
            );
          })}
          {diff.more > 0 ? <text fg={color.faint}>{`… ${diff.more} more line${diff.more === 1 ? "" : "s"} (ctrl+o)`}</text> : null}
        </box>
      ) : null}
      <box flexDirection="column">
        {choices.map((c, i) => (
          <text key={c.mode} fg={i === selected ? color.white : color.textDim} bg={i === selected ? color.panel : undefined}>
            <span fg={i === selected ? tone : color.faint}>{i === selected ? "❯ " : "  "}{i + 1}.</span> {i === selected ? <b>{c.label}</b> : c.label}
            <span fg={color.faint}>{` (${approvalKey(c)})`}</span>
          </text>
        ))}
      </box>
      {/* The letters these choices actually have ("d" was missing from "y/a/n"). */}
      <text fg={color.muted}>{`↑↓ choose · enter confirm · ${[...new Set(choices.map(approvalKey))].join("/")} · esc no`}</text>
    </box>
  );
}
