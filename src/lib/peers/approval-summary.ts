/**
 * What another session sees of a pending permission request (0aa): built once,
 * in main, from the request itself, so the app, VS Code, editors and the CLI
 * all publish the same thing (only the CLI used to, so a reviewer saw nothing
 * of an app session's requests).
 */
import type { PendingApprovalSummary } from "./peers";

/** Enough of a diff or a command to judge it; the rest is said to be cut. */
export const APPROVAL_DETAIL_CAP = 4_000;

type AnyPreview = {
  command?: string;
  workingDirectory?: string;
  description?: string;
  isDangerous?: boolean;
  dangerExplanation?: string;
  systemScope?: boolean;
  systemScopeExplanation?: string;
  path?: string;
  type?: string;
  diff?: string;
  content?: string;
  fromPath?: string;
  toPath?: string;
  deniedPath?: string;
  grantPath?: string;
  operations?: AnyPreview[];
};

function cap(text: string): string {
  return text.length > APPROVAL_DETAIL_CAP
    ? `${text.slice(0, APPROVAL_DETAIL_CAP)}\n[cut: ${text.length.toLocaleString("en-US")} characters in all]`
    : text;
}

function oneLine(p: AnyPreview, operation: string | undefined): string {
  if (p.command) return p.command;
  if (p.deniedPath) return `sandbox write denied: ${p.deniedPath}${p.grantPath ? ` (grant ${p.grantPath})` : ""}`;
  if (p.fromPath && p.toPath) return `rename ${p.fromPath} → ${p.toPath}`;
  if (p.path) return `${p.type ?? "edit"} ${p.path}`;
  if (p.operations?.length) return `${p.operations.length} changes: ${p.operations.map((o) => oneLine(o, undefined)).join(", ")}`;
  return p.description ?? operation ?? "unknown";
}

function detailOf(p: AnyPreview): string {
  if (p.command) {
    return [
      p.description && `what: ${p.description}`,
      p.dangerExplanation && `risk: ${p.dangerExplanation}`,
      p.systemScopeExplanation && `outside the project: ${p.systemScopeExplanation}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (p.diff) return p.diff;
  // A new file has no diff: its content is the change.
  if (p.type === "create" && typeof p.content === "string") return p.content;
  if (p.operations?.length) return p.operations.map((o) => `${oneLine(o, undefined)}\n${detailOf(o)}`.trim()).join("\n\n");
  return p.description ?? "";
}

export function summarizePermissionRequest(
  operationId: string,
  request: { operation?: string; preview?: unknown } | undefined,
): PendingApprovalSummary {
  const p = (request?.preview ?? {}) as AnyPreview;
  const flags = [p, ...(p.operations ?? [])];
  const detail = detailOf(p).trim();
  return {
    operationId,
    operation: request?.operation,
    summary: oneLine(p, request?.operation),
    ...(detail ? { detail: cap(detail) } : {}),
    ...(p.workingDirectory ? { cwd: p.workingDirectory } : {}),
    ...(flags.some((f) => f.isDangerous) ? { isDangerous: true } : {}),
    ...(flags.some((f) => f.systemScope) ? { systemScope: true } : {}),
  };
}

/** Whether a peer session may approve this request: high-risk ones need the owner (dynamic signals only). */
export function isPeerApprovableSummary(s: PendingApprovalSummary): boolean {
  return !(s.isDangerous || s.systemScope || s.operation === "sandbox_escalation");
}
