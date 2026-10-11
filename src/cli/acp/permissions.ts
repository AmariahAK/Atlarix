/**
 * An approval the agent is waiting on, as an editor's Allow/Deny prompt
 * (`session/request_permission`), and the editor's answer back as the approval
 * mode the desktop understands (`execute-permission`).
 *
 * The choices are the TUI's own (approval-choices.ts): "always" is offered only
 * where the request says it can be remembered. A dismissed prompt is a No: the
 * agent never proceeds on silence.
 */
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionOutcome,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { approvalChoices, approvalTitle, firstPreview, type ApprovalChoice } from "../agent/approval-choices";
import type { McpConsentRequest, PendingApproval } from "../agent/session";
import type { Cell } from "../agent/transcript";
import { toolNameFromId } from "./updates";

const KIND: Record<ApprovalChoice["mode"], PermissionOptionKind> = {
  once: "allow_once",
  always_allow: "allow_always",
  always_allow_file: "allow_always",
  always_allow_directory: "allow_always",
  deny: "reject_once",
};

function approvalKind(a: PendingApproval): ToolKind {
  const p = firstPreview(a);
  if (p.command) return "execute";
  if (p.type === "delete") return "delete";
  if (p.type === "rename") return "move";
  if (p.path) return "edit";
  return "other";
}

/** The tool whose call raised each kind of operation (to attach the prompt to that call). */
const OPERATION_TOOL: Record<string, string> = {
  edit_file: "edit_file",
  delete_file: "edit_file",
  rename_file: "edit_file",
  run_command: "run_command",
};

/**
 * The tool call this approval belongs to: the newest running call of that tool
 * on that file (or of that command), so the editor shows Allow/Deny INSIDE the
 * call's card rather than as a second one. Null when none matches (an
 * escalation raised mid-command, an automation): the prompt gets its own card.
 */
export function approvalOwner(a: PendingApproval, cells: readonly Cell[]): string | null {
  const tool = OPERATION_TOOL[a.request.operation ?? ""];
  if (!tool) return null;
  const p = firstPreview(a);
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!;
    if (c.kind !== "tool" || c.tool.status !== "running" || toolNameFromId(c.id) !== tool) continue;
    if (p.path && c.tool.target && !c.tool.target.endsWith(p.path) && !p.path.endsWith(c.tool.target)) continue;
    return c.id;
  }
  return null;
}

export function approvalToolCall(a: PendingApproval, owner?: string): ToolCallUpdate {
  const toolCallId = owner ?? `approval:${a.operationId}`;
  const p = firstPreview(a);
  const content: ToolCallContent[] = [];
  if (p.path && (typeof p.content === "string" || typeof p.oldContent === "string") && p.type !== "delete") {
    content.push({ type: "diff", path: p.path, oldText: p.oldContent ?? null, newText: p.content ?? "" });
  }
  const note = [
    p.command ? `$ ${p.command}` : "",
    p.deniedPath ? `Write outside the sandbox: ${p.grantPath ?? p.deniedPath}` : "",
    p.description ?? "",
    p.isDangerous && p.dangerExplanation ? `Risky: ${p.dangerExplanation}` : "",
    p.systemScope && p.systemScopeExplanation ? p.systemScopeExplanation : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (note) content.push({ type: "content", content: { type: "text", text: note } });
  // The same facts, structured, for Atlarix's own extension's approval bar
  // (other editors ignore _meta and read the note above).
  const _meta = {
    atlarix: {
      approval: {
        command: p.command ?? null,
        path: p.path ?? null,
        risky: !!p.isDangerous,
        risk: (p.isDangerous ? p.dangerExplanation : null) ?? (p.systemScope ? p.systemScopeExplanation : null) ?? null,
        outside: p.deniedPath ? (p.grantPath ?? p.deniedPath) : null,
      },
    },
  };
  // Inside the call's own card: keep its title; add what it is asking to do.
  if (owner) return { toolCallId, status: "pending", ...(content.length ? { content } : {}), _meta };
  const title = p.command ? `Run ${p.command}` : p.path ? `${approvalTitle(a).replace(/\?$/, "")}: ${p.path}` : approvalTitle(a);
  return {
    toolCallId,
    title,
    kind: approvalKind(a),
    status: "pending",
    ...(p.path ? { locations: [{ path: p.path }] } : {}),
    ...(content.length ? { content } : {}),
    _meta,
  };
}

/**
 * The choices offered. `attached`: the prompt sits inside the tool call that
 * raised it. A prompt with a card of its own offers only Yes (once) / No: in
 * testing, Zed answered one such prompt "always allow this file" with nobody
 * at the keyboard (2026-10-09, cause unknown), and a standing rule is the one
 * answer that must never come from anything but a person's click.
 */
export function approvalOptions(a: PendingApproval, attached = true): PermissionOption[] {
  const choices = approvalChoices(a).filter((c) => attached || c.mode === "once" || c.mode === "deny");
  return choices.map((c) => ({
    optionId: c.mode,
    // The TUI's "No — tell Atlarix what to do instead" reads oddly as a button.
    name: c.mode === "deny" ? "No" : c.label,
    kind: KIND[c.mode],
  }));
}

/** The editor's answer as an approval mode; anything but a known choice is a No. */
export function approvalMode(a: PendingApproval, outcome: RequestPermissionOutcome): ApprovalChoice["mode"] {
  if (outcome.outcome !== "selected") return "deny";
  return approvalChoices(a).find((c) => c.mode === outcome.optionId)?.mode ?? "deny";
}

export function mcpConsentToolCall(r: McpConsentRequest): ToolCallUpdate {
  return {
    toolCallId: `mcp-consent:${r.requestId}`,
    title: `Use ${r.toolName} from ${r.serverName}`,
    kind: "other",
    status: "pending",
    content: [
      {
        type: "content",
        content: { type: "text", text: [r.toolDescription, r.inputPreview].filter(Boolean).join("\n\n") || r.toolName },
      },
    ],
  };
}

/** A card of its own, so no "always" (see approvalOptions); the app and TUI still offer it. */
export const MCP_CONSENT_OPTIONS: PermissionOption[] = [
  { optionId: "accept-once", name: "Allow once", kind: "allow_once" },
  { optionId: "decline", name: "No", kind: "reject_once" },
];

export function mcpConsentDecision(outcome: RequestPermissionOutcome): "accept-once" | "accept-always" | "decline" {
  if (outcome.outcome !== "selected") return "decline";
  return outcome.optionId === "accept-once" ? "accept-once" : "decline";
}
