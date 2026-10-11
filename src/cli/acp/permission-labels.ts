/**
 * A remembered permission as a person reads it: "rm -rf" not "danger:rm-rf",
 * "Never" not "always_deny". The desktop's ruleLabel (WorkspaceTerminalPermissions.tsx) for commands.
 */
import type { SavedPermission } from "../agent/services";

export interface ReadablePermission {
  kind: "command" | "file";
  /** What it covers: `npm`, `rm -rf`, `folder src`, `.ts files`. */
  label: string;
  /** Shown as Always / Never. */
  decision: "always" | "never";
  /** A risky command's rule (shown with a warning tint). */
  risky: boolean;
}

export function readablePermission(p: SavedPermission): ReadablePermission {
  const decision = p.decision === "always_deny" ? "never" : "always";
  if (p.kind === "command") {
    if (p.label.startsWith("danger:")) {
      const ids = p.label.slice("danger:".length).split("+");
      return { kind: "command", label: ids.map((id) => id.replace(/^cmd-/, "").replace(/-/g, " ")).join(" + "), decision, risky: true };
    }
    if (p.label.startsWith("mutate:")) {
      return { kind: "command", label: p.label.slice("mutate:".length).replace(/-/g, " "), decision, risky: false };
    }
    return { kind: "command", label: `${p.label} commands`, decision, risky: false };
  }
  const r = p.revoke as { scopeType: string; scopeValue: string };
  const label = r.scopeType === "extension" ? `${r.scopeValue} files` : r.scopeType === "directory" ? `folder ${r.scopeValue}/` : r.scopeType === "sandbox_path" ? `writing to ${r.scopeValue}` : r.scopeValue;
  return { kind: "file", label, decision, risky: false };
}
