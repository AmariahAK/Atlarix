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

export function approvalToolCall(a: PendingApproval): ToolCallUpdate {
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
  const title = p.command ? `Run ${p.command}` : p.path ? `${approvalTitle(a).replace(/\?$/, "")}: ${p.path}` : approvalTitle(a);
  return {
    toolCallId: `approval:${a.operationId}`,
    title,
    kind: approvalKind(a),
    status: "pending",
    ...(p.path ? { locations: [{ path: p.path }] } : {}),
    ...(content.length ? { content } : {}),
  };
}

export function approvalOptions(a: PendingApproval): PermissionOption[] {
  return approvalChoices(a).map((c) => ({
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

export const MCP_CONSENT_OPTIONS: PermissionOption[] = [
  { optionId: "accept-once", name: "Allow once", kind: "allow_once" },
  { optionId: "accept-always", name: "Always allow this tool", kind: "allow_always" },
  { optionId: "decline", name: "No", kind: "reject_once" },
];

export function mcpConsentDecision(outcome: RequestPermissionOutcome): "accept-once" | "accept-always" | "decline" {
  if (outcome.outcome !== "selected") return "decline";
  return outcome.optionId === "accept-once" || outcome.optionId === "accept-always" ? outcome.optionId : "decline";
}
