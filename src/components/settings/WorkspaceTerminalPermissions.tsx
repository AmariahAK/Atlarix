import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

/** Friendly label for a rule key — danger keys are `danger:<id>[+<id>]`. */
function ruleLabel(category: string): { label: string; dangerous: boolean } {
  if (category.startsWith("danger:")) {
    const ids = category.slice("danger:".length).split("+");
    return {
      label: ids
        .map((id) => id.replace(/^cmd-/, "").replace(/-/g, " "))
        .join(" + "),
      dangerous: true,
    };
  }
  return { label: category, dangerous: false };
}

type PermissionRow = {
  id: number;
  appId: number;
  category: string;
  decision: "always_allow" | "always_deny";
  createdAt?: Date | null;
};

export function WorkspaceTerminalPermissions() {
  const appId = useAtomValue(selectedAppIdAtom);
  const [rows, setRows] = useState<PermissionRow[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [categoryInput, setCategoryInput] = useState("");
  const [decisionInput, setDecisionInput] = useState<
    "always_allow" | "always_deny"
  >("always_allow");
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (appId == null) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const [list, defs] = await Promise.all([
        IpcClient.getInstance().listCommandPermissions(appId),
        IpcClient.getInstance().listCommandDefaults(),
      ]);
      setRows(Array.isArray(list) ? list : []);
      setDefaults(Array.isArray(defs) ? defs : []);
    } catch {
      setRows([]);
      setDefaults([]);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (appId == null) {
    return null;
  }

  const handleAdd = async () => {
    const cat = categoryInput.trim().toLowerCase();
    if (!cat) {
      toast.error("Enter a command category (first token, e.g. git)");
      return;
    }
    const result = await IpcClient.getInstance().upsertCommandPermission({
      appId,
      category: cat,
      decision: decisionInput,
    });
    if (
      result &&
      typeof result === "object" &&
      "success" in result &&
      !result.success
    ) {
      toast.error((result as { error?: string }).error ?? "Failed to save");
      return;
    }
    setCategoryInput("");
    void reload();
  };

  const handleRevoke = async (category: string) => {
    await IpcClient.getInstance().revokeCommandPermission({ appId, category });
    void reload();
  };

  const handleDenyDefault = async (category: string) => {
    await IpcClient.getInstance().upsertCommandPermission({
      appId,
      category,
      decision: "always_deny",
    });
    void reload();
  };

  // A default is currently overridden when the user has an always_deny rule for it.
  const deniedDefaults = new Set(
    rows.filter((r) => r.decision === "always_deny").map((r) => r.category),
  );

  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border mt-6">
      <h2 className="text-lg font-medium text-foreground mb-1">
        Terminal permissions
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        Remember allow or deny decisions for command categories in this
        workspace (first token of the command, e.g.{" "}
        <code className="text-xs">git</code> for{" "}
        <code className="text-xs">git status</code>). Dangerous commands (e.g.
        force-push) are saved as their own specific rule when you choose “Always
        allow” inline, and are never auto-approved until you do — you can revoke
        any rule here.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <Input
          placeholder="Category (e.g. git)"
          value={categoryInput}
          onChange={(e) => setCategoryInput(e.target.value)}
          className="max-w-[160px] h-9"
        />
        <Select
          value={decisionInput}
          onValueChange={(v) =>
            setDecisionInput(v as "always_allow" | "always_deny")
          }
        >
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always_allow">Always allow</SelectItem>
            <SelectItem value="always_deny">Always deny</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" size="sm" onClick={() => void handleAdd()}>
          Add
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No saved rules yet.</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Category</th>
                <th className="text-left px-3 py-2 font-medium">Decision</th>
                <th className="text-right px-3 py-2 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const { label, dangerous } = ruleLabel(row.category);
                return (
                  <tr key={row.id} className="border-t border-border/60">
                    <td className="px-3 py-2 font-mono">
                      <span className="inline-flex items-center gap-2">
                        {label}
                        {dangerous ? (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                            Dangerous
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {row.decision === "always_allow"
                        ? "Always allow"
                        : "Always deny"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => void handleRevoke(row.category)}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {defaults.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-foreground mb-1">
            Built-in read-only commands
          </h3>
          <p className="text-sm text-muted-foreground mb-3">
            These read/search commands (and pipelines of them) run without a
            prompt. Deny any you don’t want auto-running — the OS sandbox still
            applies either way.
          </p>
          <div className="flex flex-wrap gap-2">
            {defaults.map((cat) => {
              const denied = deniedDefaults.has(cat);
              return (
                <span
                  key={cat}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 pl-3 pr-1 py-1 text-xs font-mono"
                >
                  <span
                    className={
                      denied ? "line-through text-muted-foreground" : ""
                    }
                  >
                    {cat}
                  </span>
                  {denied ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => void handleRevoke(cat)}
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-red-600 dark:text-red-400"
                      onClick={() => void handleDenyDefault(cat)}
                    >
                      Deny
                    </Button>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
