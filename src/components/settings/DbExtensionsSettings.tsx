/**
 * DB Extensions — UI for managing database connections (global and per-workspace).
 * Supports PostgreSQL, MySQL, and SQLite.
 */

import { useState, useEffect, useCallback } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { showSuccess, showError } from "@/lib/toast";
import {
  Database,
  Plus,
  Trash2,
  PlugZap,
  Unplug,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type DBType = "postgresql" | "mysql" | "sqlite";

interface ConnectionSummary {
  id: string;
  name: string;
  type: string;
  status: string;
  isProd?: boolean;
}

const DB_TYPE_LABELS: Record<DBType, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
};

export function DbExtensionsSettings({ workspaceId }: { workspaceId: number | null }) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);

  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState<DBType>("postgresql");
  const [formHost, setFormHost] = useState("127.0.0.1");
  const [formPort, setFormPort] = useState("5432");
  const [formUser, setFormUser] = useState("");
  const [formPass, setFormPass] = useState("");
  const [formDatabase, setFormDatabase] = useState("");
  const [formFilename, setFormFilename] = useState("");
  const [formConnString, setFormConnString] = useState("");
  const [formIsProd, setFormIsProd] = useState(false);
  const [formUseConnString, setFormUseConnString] = useState(false);

  const ipc = IpcClient.getInstance();

  const refresh = useCallback(async () => {
    try {
      const res = await ipc.dbListConnections(workspaceId);
      setConnections(res.connections);
      setActiveId(res.activeId);
    } catch (e) {
      console.warn("Failed to list DB connections", e);
    }
  }, [workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const resetForm = () => {
    setFormName("");
    setFormType("postgresql");
    setFormHost("127.0.0.1");
    setFormPort("5432");
    setFormUser("");
    setFormPass("");
    setFormDatabase("");
    setFormFilename("");
    setFormConnString("");
    setFormIsProd(false);
    setFormUseConnString(false);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      showError("Connection name is required");
      return;
    }
    const config: Record<string, unknown> = {};
    if (formType === "sqlite") {
      config.filename = formFilename || ":memory:";
    } else if (formUseConnString && formConnString) {
      config.connectionString = formConnString;
    } else {
      config.host = formHost;
      config.port = parseInt(formPort, 10) || (formType === "mysql" ? 3306 : 5432);
      config.username = formUser;
      config.password = formPass;
      config.database = formDatabase;
    }
    try {
      await ipc.dbSaveConnection({ name: formName.trim(), type: formType, config, isProd: formIsProd });
      showSuccess(`Connection "${formName.trim()}" saved`);
      resetForm();
      refresh();
    } catch {
      showError("Failed to save connection");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await ipc.dbDeleteConnection(id);
      showSuccess("Connection removed");
      refresh();
    } catch {
      showError("Failed to delete connection");
    }
  };

  const handleConnect = async (id: string) => {
    setConnecting(id);
    try {
      const res = await ipc.dbConnect(id);
      if (res.error) {
        showError(res.error);
      } else {
        showSuccess("Connected");
      }
      refresh();
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      await ipc.dbDisconnect(id);
      showSuccess("Disconnected");
      refresh();
    } catch {
      showError("Failed to disconnect");
    }
  };

  const handleSetActive = async (id: string) => {
    try {
      await ipc.dbSetActiveConnection(workspaceId, activeId === id ? null : id);
      refresh();
    } catch {
      showError("Failed to set active connection");
    }
  };

  const statusIcon = (status: string) => {
    if (status === "connected") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    if (status === "error") return <XCircle className="h-4 w-4 text-red-500" />;
    return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <h3 className="text-sm font-medium text-foreground">
            Database Connections
          </h3>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowForm(!showForm)}>
          {showForm ? (
            <>
              <ChevronUp className="h-4 w-4 mr-1" /> Cancel
            </>
          ) : (
            <>
              <Plus className="h-4 w-4 mr-1" /> Add Connection
            </>
          )}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {workspaceId != null
          ? "Add database credentials for this workspace. The AI can read schema and query data in real time."
          : "Global database connections available in regular chat (no workspace)."}
      </p>

      {/* New Connection Form */}
      {showForm && (
        <div className="border border-border rounded-lg p-4 space-y-3 bg-card/50">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Name</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="My Database"
                className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Type</label>
              <select
                value={formType}
                onChange={(e) => {
                  setFormType(e.target.value as DBType);
                  if (e.target.value === "mysql") setFormPort("3306");
                  else if (e.target.value === "postgresql") setFormPort("5432");
                }}
                className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
              >
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="sqlite">SQLite</option>
              </select>
            </div>
          </div>

          {formType === "sqlite" ? (
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">File path</label>
              <input
                value={formFilename}
                onChange={(e) => setFormFilename(e.target.value)}
                placeholder="/path/to/database.db"
                className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  id="use-conn-string"
                  type="checkbox"
                  checked={formUseConnString}
                  onChange={(e) => setFormUseConnString(e.target.checked)}
                  className="rounded border-border"
                />
                <label htmlFor="use-conn-string" className="text-xs text-muted-foreground">
                  Use connection string instead
                </label>
              </div>

              {formUseConnString ? (
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Connection String</label>
                  <input
                    value={formConnString}
                    onChange={(e) => setFormConnString(e.target.value)}
                    placeholder={formType === "postgresql" ? "postgresql://user:pass@host:5432/db" : "mysql://user:pass@host:3306/db"}
                    className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono"
                  />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Host</label>
                    <input
                      value={formHost}
                      onChange={(e) => setFormHost(e.target.value)}
                      className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Port</label>
                    <input
                      value={formPort}
                      onChange={(e) => setFormPort(e.target.value)}
                      className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Username</label>
                    <input
                      value={formUser}
                      onChange={(e) => setFormUser(e.target.value)}
                      className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Password</label>
                    <input
                      type="password"
                      value={formPass}
                      onChange={(e) => setFormPass(e.target.value)}
                      className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Database</label>
                    <input
                      value={formDatabase}
                      onChange={(e) => setFormDatabase(e.target.value)}
                      className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <div className="flex items-center gap-2">
            <input
              id="db-is-prod"
              type="checkbox"
              checked={formIsProd}
              onChange={(e) => setFormIsProd(e.target.checked)}
              className="rounded border-border"
            />
            <label htmlFor="db-is-prod" className="text-xs text-muted-foreground">
              Production database (AI will add extra confirmation before writes)
            </label>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
            <Button size="sm" onClick={handleSave}>Save Connection</Button>
          </div>
        </div>
      )}

      {/* Connection List */}
      {connections.length === 0 && !showForm && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No database connections configured.
        </div>
      )}

      {connections.map((conn) => (
        <div
          key={conn.id}
          className={cn(
            "flex items-center justify-between p-3 rounded-lg border transition-colors",
            activeId === conn.id
              ? "border-primary/50 bg-primary/5"
              : "border-border bg-card/50"
          )}
        >
          <div className="flex items-center gap-3 min-w-0">
            {statusIcon(conn.status)}
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground truncate">
                {conn.name}
                {conn.isProd && (
                  <span className="ml-2 text-[10px] bg-amber-500/20 text-amber-600 px-1.5 py-0.5 rounded font-semibold uppercase">
                    Prod
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {DB_TYPE_LABELS[conn.type as DBType] ?? conn.type} — {conn.status}
                {activeId === conn.id && " (active)"}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {conn.status === "connected" ? (
              <Button variant="ghost" size="sm" onClick={() => handleDisconnect(conn.id)} title="Disconnect">
                <Unplug className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleConnect(conn.id)}
                disabled={connecting === conn.id}
                title="Connect"
              >
                <PlugZap className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant={activeId === conn.id ? "default" : "ghost"}
              size="sm"
              onClick={() => handleSetActive(conn.id)}
              title={activeId === conn.id ? "Deactivate" : "Set as active"}
            >
              <Database className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleDelete(conn.id)} title="Delete">
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
