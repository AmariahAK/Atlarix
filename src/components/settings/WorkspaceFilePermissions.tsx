import { useCallback, useEffect, useMemo, useState } from "react";
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

type FilePermissionRow = {
  id: number;
  appId: number;
  scopeType: "file" | "directory" | "extension";
  scopeValue: string;
  decision: "always_allow" | "always_deny";
  createdAt?: Date | null;
};

function PermissionTable({
  title,
  rows,
  onRevoke,
}: {
  title: string;
  rows: FilePermissionRow[];
  onRevoke: (row: FilePermissionRow) => void;
}) {
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No {title.toLowerCase()} rules yet.
      </p>
    );
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden mb-4">
      <div className="px-3 py-2 bg-muted/40 text-sm font-medium">{title}</div>
      <table className="w-full text-sm">
        <thead className="bg-muted/20">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Scope</th>
            <th className="text-left px-3 py-2 font-medium">Decision</th>
            <th className="text-right px-3 py-2 font-medium"> </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-border/60">
              <td className="px-3 py-2 font-mono break-all">{row.scopeValue}</td>
              <td className="px-3 py-2">
                {row.decision === "always_allow" ? "Always allow" : "Always deny"}
              </td>
              <td className="px-3 py-2 text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onRevoke(row)}
                >
                  Revoke
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WorkspaceFilePermissions() {
  const appId = useAtomValue(selectedAppIdAtom);
  const [rows, setRows] = useState<FilePermissionRow[]>([]);
  const [scopeType, setScopeType] = useState<"file" | "directory" | "extension">("file");
  const [scopeValue, setScopeValue] = useState("");
  const [decision, setDecision] = useState<"always_allow" | "always_deny">("always_allow");
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (appId == null) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const list = await IpcClient.getInstance().listFilePermissions(appId);
      setRows(Array.isArray(list) ? list : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byType = useMemo(
    () => ({
      file: rows.filter((r) => r.scopeType === "file"),
      directory: rows.filter((r) => r.scopeType === "directory"),
      extension: rows.filter((r) => r.scopeType === "extension"),
    }),
    [rows],
  );

  if (appId == null) {
    return null;
  }

  const handleAdd = async () => {
    const value = scopeValue.trim();
    if (!value) {
      toast.error("Enter a path or extension (e.g. src/foo.ts or .ts)");
      return;
    }
    const result = await IpcClient.getInstance().upsertFilePermission({
      appId,
      scopeType,
      scopeValue: value,
      decision,
    });
    if (result && typeof result === "object" && "success" in result && !result.success) {
      toast.error((result as { error?: string }).error ?? "Failed to save");
      return;
    }
    setScopeValue("");
    void reload();
  };

  const handleRevoke = async (row: FilePermissionRow) => {
    await IpcClient.getInstance().revokeFilePermission({
      appId,
      scopeType: row.scopeType,
      scopeValue: row.scopeValue,
    });
    void reload();
  };

  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border mt-6">
      <h2 className="text-lg font-medium text-foreground mb-1">File permissions</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Remember allow or deny decisions for files, directories, or extensions in this workspace.
        Protected paths (lockfiles, secrets, migrations, CI) always require inline approval.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <Select
          value={scopeType}
          onValueChange={(v) => setScopeType(v as "file" | "directory" | "extension")}
        >
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="file">File</SelectItem>
            <SelectItem value="directory">Directory</SelectItem>
            <SelectItem value="extension">Extension</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder={
            scopeType === "extension"
              ? ".ts"
              : scopeType === "directory"
                ? "src/components"
                : "src/foo.ts"
          }
          value={scopeValue}
          onChange={(e) => setScopeValue(e.target.value)}
          className="max-w-[220px] h-9"
        />
        <Select
          value={decision}
          onValueChange={(v) => setDecision(v as "always_allow" | "always_deny")}
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
      ) : (
        <>
          <PermissionTable title="Files" rows={byType.file} onRevoke={handleRevoke} />
          <PermissionTable title="Directories" rows={byType.directory} onRevoke={handleRevoke} />
          <PermissionTable title="Extensions" rows={byType.extension} onRevoke={handleRevoke} />
        </>
      )}
    </div>
  );
}
