/** @jsxImportSource @opentui/react */
/**
 * "Run this command?" — the permission prompt, from the agent's own
 * permission-request. Choices map to the approval modes the desktop sends
 * (execute-permission): once, always for this folder, or no.
 */
import { approvalDiff } from "../agent/approval-diff";
import { getCommandCategory } from "@/lib/terminal-command-category";
import type { PendingApproval } from "../agent/session";
import { color } from "./theme";

export type ApprovalChoice = { label: string; mode: "once" | "always_allow" | "always_allow_file" | "always_allow_directory" | "deny" };

/**
 * A letter for each choice (Codex's y / a / p / esc): y yes, a the first
 * "always", d the folder-wide one, n no. Numbers work too.
 */
export function approvalKey(c: ApprovalChoice): string {
  return { once: "y", always_allow: "a", always_allow_file: "a", always_allow_directory: "d", deny: "n" }[c.mode];
}

interface Preview {
  command?: string;
  workingDirectory?: string;
  description?: string;
  isDangerous?: boolean;
  dangerExplanation?: string;
  systemScope?: boolean;
  systemScopeExplanation?: string;
  path?: string;
  type?: string;
  /** NOT reliably text (edit_file sends a summary object); see approval-diff.ts. */
  diff?: unknown;
  content?: string;
  oldContent?: string;
  lines?: number;
  deniedPath?: string;
  grantPath?: string;
  canAlwaysAllow?: boolean;
  canAlwaysAllowFile?: boolean;
  canAlwaysAllowDirectory?: boolean;
  fileParentDir?: string;
}

function firstPreview(a: PendingApproval): Preview {
  const p = a.request.preview;
  return ((Array.isArray(p) ? p[0] : p) ?? {}) as Preview;
}

/**
 * The same choices as the desktop's card (InlinePermissionApprovals.tsx): an
 * "always" option unless the request says it cannot be remembered
 * (`canAlwaysAllow: false`, e.g. a change outside the project, which is never
 * blanket-approved). A risky command's rule covers that exact command; any
 * other command's covers its category (`npm`, `brew`).
 */
export function approvalChoices(a: PendingApproval): ApprovalChoice[] {
  const p = firstPreview(a);
  const choices: ApprovalChoice[] = [{ label: "Yes", mode: "once" }];
  if (p.command) {
    if (p.canAlwaysAllow !== false) {
      const what = p.isDangerous ? "this command" : `\`${getCommandCategory(p.command)}\` commands`;
      choices.push({ label: `Yes, and always allow ${what} in this folder`, mode: "always_allow" });
    }
  } else if (p.path) {
    if (p.canAlwaysAllowFile !== false) {
      choices.push({ label: "Yes, and allow edits to this file from now on", mode: "always_allow_file" });
    }
    if (p.canAlwaysAllowDirectory !== false && p.fileParentDir) {
      choices.push({ label: `Yes, and allow edits in ${p.fileParentDir}/ from now on`, mode: "always_allow_directory" });
    }
  }
  choices.push({ label: "No — tell Atlarix what to do instead", mode: "deny" });
  return choices;
}

export function approvalTitle(a: PendingApproval): string {
  const p = firstPreview(a);
  if (p.command) return "Run this command?";
  if (p.deniedPath) return "Allow writing outside the sandbox?";
  if (p.type === "delete") return "Delete this file?";
  if (p.type === "create") return "Create this file?";
  if (p.path) return "Edit this file?";
  return "Allow this?";
}

export function Approval({ approval, selected }: { approval: PendingApproval; selected: number }) {
  const p = firstPreview(approval);
  const choices = approvalChoices(approval);
  const shown = p.command ?? p.path ?? p.deniedPath ?? "";
  const diff = approvalDiff(p);
  return (
    <box border borderStyle="rounded" borderColor={color.warn} backgroundColor={color.warnBg} padding={1} flexDirection="column" gap={1} flexShrink={0}>
      <text fg={color.warn}>
        <b>{`△ ${approvalTitle(approval)}`}</b>
      </text>
      {shown ? (
        <box backgroundColor={color.bg} paddingLeft={1} paddingRight={1}>
          <text fg={color.text}>{p.command ? `$ ${shown}` : shown}</text>
        </box>
      ) : null}
      {p.description ? <text fg={color.textDim}>{p.description}</text> : null}
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
          {diff.lines.map((l, i) => (
            <text
              key={i}
              fg={l.kind === "add" ? color.accentSoft : l.kind === "remove" ? color.error : color.muted}
              bg={l.kind === "add" ? color.addBg : l.kind === "remove" ? color.removeBg : undefined}
            >
              {l.text || " "}
            </text>
          ))}
          {diff.more > 0 ? <text fg={color.faint}>… {diff.more} more lines</text> : null}
        </box>
      ) : null}
      <box flexDirection="column">
        {choices.map((c, i) => (
          <text key={c.mode} fg={i === selected ? color.white : color.textDim} bg={i === selected ? color.warnBg : undefined}>
            <span fg={i === selected ? color.warn : color.faint}>{i === selected ? "❯ " : "  "}{i + 1}.</span> {i === selected ? <b>{c.label}</b> : c.label}
            <span fg={color.faint}>{` (${approvalKey(c)})`}</span>
          </text>
        ))}
      </box>
      <text fg={color.muted}>↑↓ choose · enter confirm · y/a/n · esc no</text>
    </box>
  );
}
