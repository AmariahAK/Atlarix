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
import { FolderPlus } from "lucide-react";
import { chooseFolder } from "@/lib/choose-folder";

type FilePermissionRow = {
  id: number;
  appId: number;
  scopeType: "file" | "directory" | "folder" | "extension";
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
              <td className="px-3 py-2 font-mono break-all">
                {row.scopeValue}
                {row.scopeType === "directory" ? "/**" : ""}
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
  const [scopeType, setScopeType] = useState<
    "file" | "directory" | "folder" | "extension"
  >("file");
  const [scopeValue, setScopeValue] = useState("");
  const [decision, setDecision] = useState<"always_allow" | "always_deny">(
    "always_allow",
  );
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
      directory: rows.filter(
        (r) => r.scopeType === "directory" || r.scopeType === "folder",
      ),
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
    if (
      result &&
      typeof result === "object" &&
      "success" in result &&
      !result.success
    ) {
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
      <h2 className="text-lg font-medium text-foreground mb-1">
        File permissions
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        Saved allow and deny rules. Protected paths always ask.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <Select
          value={scopeType}
          onValueChange={(v) =>
            setScopeType(v as "file" | "directory" | "folder" | "extension")
          }
        >
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="file">File</SelectItem>
            <SelectItem value="directory">Directory/**</SelectItem>
            <SelectItem value="folder">Folder (only)</SelectItem>
            <SelectItem value="extension">Extension</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder={
            scopeType === "extension"
              ? ".ts"
              : scopeType === "directory" || scopeType === "folder"
                ? "src/components"
                : "src/foo.ts"
          }
          value={scopeValue}
          onChange={(e) => setScopeValue(e.target.value)}
          className="max-w-[220px] h-9"
        />
        <Select
          value={decision}
          onValueChange={(v) =>
            setDecision(v as "always_allow" | "always_deny")
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
      ) : (
        <>
          <PermissionTable
            title="Files"
            rows={byType.file}
            onRevoke={handleRevoke}
          />
          <PermissionTable
            title="Directories"
            rows={byType.directory}
            onRevoke={handleRevoke}
          />
          <PermissionTable
            title="Extensions"
            rows={byType.extension}
            onRevoke={handleRevoke}
          />
        </>
      )}
    </div>
  );
}

/**
 * Folders OUTSIDE this workspace that Atlarix may write in.
 *
 * A separate table from the rules above because these are absolute OS paths
 * rather than workspace-relative scopes — `listWorkspaceFilePermissions`
 * deliberately excludes them for exactly that reason.
 *
 * One list serves both lanes: sandboxed commands and `edit_file`. Before this,
 * a folder granted to a blocked command was still refused to the editor, and
 * the escalation card promised a Settings page to revoke from that did not
 * exist.
 */
export function WorkspaceGrantedFolders() {
  const appId = useAtomValue(selectedAppIdAtom);
  const [folders, setFolders] = useState<
    Array<{ path: string; exists: boolean }>
  >([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (appId == null) {
      setFolders([]);
      return;
    }
    setLoading(true);
    try {
      const list = await IpcClient.getInstance().listGrantedFolders(appId);
      setFolders(Array.isArray(list) ? list : []);
    } catch {
      setFolders([]);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (appId == null) return null;

  const handleAdd = async () => {
    const picked = await chooseFolder();
    if (!picked) return; // cancelled, or the picker already explained itself
    const result = await IpcClient.getInstance().grantFolder({
      appId,
      path: picked,
    });
    if (!result?.success) {
      toast.error(result?.error ?? "Couldn't grant that folder.");
      return;
    }
    toast.success(`Atlarix can now write in ${result.path ?? picked}`);
    void reload();
  };

  const handleRevoke = async (folderPath: string) => {
    await IpcClient.getInstance().revokeGrantedFolder({
      appId,
      path: folderPath,
    });
    void reload();
  };

  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border mt-6">
      <h2 className="text-lg font-medium text-foreground mb-1">
        Folders outside this workspace
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        Other folders Atlarix may work in. Each change still asks.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <Button type="button" size="sm" onClick={() => void handleAdd()}>
          <FolderPlus className="h-4 w-4 mr-1.5" />
          Add folder…
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : folders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No folders granted. Atlarix can only write inside this workspace.
        </p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Folder</th>
                <th className="text-right px-3 py-2 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {folders.map((f) => (
                <tr key={f.path} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs break-all">
                    {f.path}
                    {!f.exists ? (
                      <span className="ml-2 font-sans text-[11px] text-muted-foreground">
                        (folder no longer exists)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleRevoke(f.path)}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
