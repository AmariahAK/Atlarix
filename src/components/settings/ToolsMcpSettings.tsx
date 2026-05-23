import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMcp, type Transport } from "@/hooks/useMcp";
import { useAuth } from "@/lib/auth/useAuth";
import { showError, showInfo, showSuccess } from "@/lib/toast";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Edit2,
  Eye,
  EyeOff,
  Plus,
  Save,
  Trash2,
  X,
  Wifi,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { UrlInputField, UrlReadOnlyRow } from "@/components/settings/UrlDisplayField";
import { IpcClient } from "@/ipc/ipc_client";
import { useUpgrade } from "@/hooks/useUpgrade";
import { useDeepLink } from "@/contexts/DeepLinkContext";
import { AddMcpServerDeepLinkData } from "@/ipc/deep_link_data";

type KeyValue = { key: string; value: string };

function parseEnvJsonToArray(
  envJson?: Record<string, string> | string | null,
): KeyValue[] {
  if (!envJson) return [];
  try {
    const obj =
      typeof envJson === "string"
        ? (JSON.parse(envJson) as unknown as Record<string, string>)
        : (envJson as Record<string, string>);
    return Object.entries(obj).map(([key, value]) => ({
      key,
      value: String(value ?? ""),
    }));
  } catch {
    return [];
  }
}

function arrayToEnvObject(envVars: KeyValue[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { key, value } of envVars) {
    if (key.trim().length === 0) continue;
    env[key.trim()] = value;
  }
  return env;
}

function EnvVarsEditor({
  serverId,
  envJson,
  disabled,
  onSave,
  isSaving,
}: {
  serverId: number;
  envJson?: Record<string, string> | null;
  disabled?: boolean;
  onSave: (envVars: KeyValue[]) => Promise<void>;
  isSaving: boolean;
}) {
  const initial = useMemo(() => parseEnvJsonToArray(envJson), [envJson]);
  const [envVars, setEnvVars] = useState<KeyValue[]>(initial);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingKeyValue, setEditingKeyValue] = useState("");
  const [editingValue, setEditingValue] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [isAddingNew, setIsAddingNew] = useState(false);

  React.useEffect(() => {
    setEnvVars(initial);
  }, [serverId, initial]);

  const saveAll = async (next: KeyValue[]) => {
    await onSave(next);
    setEnvVars(next);
  };

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) {
      showError("Both key and value are required");
      return;
    }
    if (envVars.some((e) => e.key === newKey.trim())) {
      showError("Environment variable with this key already exists");
      return;
    }
    const next = [...envVars, { key: newKey.trim(), value: newValue.trim() }];
    await saveAll(next);
    setNewKey("");
    setNewValue("");
    setIsAddingNew(false);
    showSuccess("Environment variables saved");
  };

  const handleEdit = (kv: KeyValue) => {
    setEditingKey(kv.key);
    setEditingKeyValue(kv.key);
    setEditingValue(kv.value);
  };

  const handleSaveEdit = async () => {
    if (!editingKey) return;
    if (!editingKeyValue.trim() || !editingValue.trim()) {
      showError("Both key and value are required");
      return;
    }
    if (
      envVars.some(
        (e) => e.key === editingKeyValue.trim() && e.key !== editingKey,
      )
    ) {
      showError("Environment variable with this key already exists");
      return;
    }
    const next = envVars.map((e) =>
      e.key === editingKey
        ? { key: editingKeyValue.trim(), value: editingValue.trim() }
        : e,
    );
    await saveAll(next);
    setEditingKey(null);
    setEditingKeyValue("");
    setEditingValue("");
    showSuccess("Environment variables saved");
  };

  const handleCancelEdit = () => {
    setEditingKey(null);
    setEditingKeyValue("");
    setEditingValue("");
  };

  const handleDelete = async (key: string) => {
    const next = envVars.filter((e) => e.key !== key);
    await saveAll(next);
    showSuccess("Environment variables saved");
  };

  return (
    <div className="mt-3 space-y-3">
      {isAddingNew ? (
        <div className="space-y-3 p-3 border rounded-md bg-muted/50">
          <div className="space-y-2">
            <Label htmlFor={`env-new-key-${serverId}`}>Key</Label>
            <Input
              id={`env-new-key-${serverId}`}
              placeholder="e.g., PATH"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              autoFocus
              disabled={disabled || isSaving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`env-new-value-${serverId}`}>Value</Label>
            <Input
              id={`env-new-value-${serverId}`}
              placeholder="e.g., /usr/local/bin"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              disabled={disabled || isSaving}
            />
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleAdd}
              size="sm"
              disabled={disabled || isSaving}
            >
              <Save size={14} />
              {isSaving ? "Saving..." : "Save"}
            </Button>
            <Button
              onClick={() => {
                setIsAddingNew(false);
                setNewKey("");
                setNewValue("");
              }}
              variant="outline"
              size="sm"
            >
              <X size={14} />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          onClick={() => setIsAddingNew(true)}
          variant="outline"
          className="w-full"
          disabled={disabled}
        >
          <Plus size={14} />
          Add Environment Variable
        </Button>
      )}

      <div className="space-y-2">
        {envVars.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No environment variables configured
          </p>
        ) : (
          envVars.map((kv) => (
            <div
              key={kv.key}
              className="flex items-center space-x-2 p-2 border rounded-md"
            >
              {editingKey === kv.key ? (
                <>
                  <div className="flex-1 space-y-2">
                    <Input
                      value={editingKeyValue}
                      onChange={(e) => setEditingKeyValue(e.target.value)}
                      placeholder="Key"
                      className="h-8"
                      disabled={disabled || isSaving}
                    />
                    <Input
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      placeholder="Value"
                      className="h-8"
                      disabled={disabled || isSaving}
                    />
                  </div>
                  <div className="flex gap-1">
                    <Button
                      onClick={handleSaveEdit}
                      size="sm"
                      variant="outline"
                      disabled={disabled || isSaving}
                    >
                      <Save size={14} />
                    </Button>
                    <Button
                      onClick={handleCancelEdit}
                      size="sm"
                      variant="outline"
                    >
                      <X size={14} />
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{kv.key}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {kv.value}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      onClick={() => handleEdit(kv)}
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      disabled={disabled}
                    >
                      <Edit2 size={14} />
                    </Button>
                    <Button
                      onClick={() => handleDelete(kv.key)}
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      disabled={disabled || isSaving}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function ToolsMcpSettings({
  maxServers,
  scope = "global",
  appId,
}: {
  maxServers?: number;
  scope?: "global" | "workspace";
  appId?: number | null;
} = {}) {
  const filter =
    scope === "workspace" && appId != null
      ? { scope: "workspace" as const, appId }
      : scope === "global"
        ? { scope: "global" as const }
        : undefined;
  const {
    servers,
    toolsByServer,
    consentsMap,
    createServer,
    toggleEnabled: toggleServerEnabled,
    deleteServer,
    setToolConsent: updateToolConsent,
    updateServer,
    isUpdatingServer,
    isDeleting,
    refetchAll,
  } = useMcp(filter);
  const { status: authStatus, loading: authLoading } = useAuth();
  const { handleUpgrade } = useUpgrade();
  const plan = authStatus?.plan;
  const isPro = plan === "pro" || plan === "workforce";
  // Only enforce the free-tier limit when we know the user is on the free plan.
  const mcpAtFreeLimit = !authLoading && plan === "free" && servers.length >= 1;
  const atMaxServers = maxServers != null && servers.length >= maxServers;
  const countLabel = maxServers != null ? `${servers.length}/${maxServers}` : null;

  const [consents, setConsents] = useState<Record<string, any>>({});
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<string>("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [expandedServerIds, setExpandedServerIds] = useState<Set<number>>(
    () => new Set(),
  );
  const { lastDeepLink, clearLastDeepLink } = useDeepLink();

  const [testingId, setTestingId] = useState<number | null>(null);
  const toggleServerExpanded = (serverId: number) => {
    setExpandedServerIds((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  useEffect(() => {
    const handleDeepLink = async () => {
      if (lastDeepLink?.type === "add-mcp-server") {
        const deepLink = lastDeepLink as AddMcpServerDeepLinkData;
        const payload = deepLink.payload;
        showInfo(`Prefilled ${payload.name} MCP server`);
        setName(payload.name);
        setTransport(payload.config.type);
        if (payload.config.type === "stdio") {
          const [cmd, ...rest] = payload.config.command.split(" ");
          setCommand(cmd);
          setArgs(rest.join(" "));
        } else {
          setUrl(payload.config.url);
        }
        clearLastDeepLink();
      }
    };
    void handleDeepLink();
  }, [lastDeepLink?.timestamp, clearLastDeepLink, lastDeepLink]);

  React.useEffect(() => {
    setConsents(consentsMap);
  }, [consentsMap]);

  const onCreate = async () => {
    if (mcpAtFreeLimit) {
      showError("Free tier is limited to 1 MCP server. Upgrade to Pro for unlimited.");
      return;
    }
    const parsedArgs = (() => {
      const trimmed = args.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith("[")) {
        try {
          const arr = JSON.parse(trimmed);
          return Array.isArray(arr) && arr.every((x) => typeof x === "string")
            ? (arr as string[])
            : null;
        } catch {
          // fall through
        }
      }
      return trimmed.split(" ").filter(Boolean);
    })();
    try {
      await createServer({
        name,
        transport,
        command: command || null,
        args: parsedArgs,
        url: url || null,
        apiKey: apiKey.trim() || null,
        enabled,
        scope: scope ?? "global",
        appId: scope === "workspace" ? appId ?? null : null,
      });
      setName("");
      setCommand("");
      setArgs("");
      setUrl("");
      setApiKey("");
      setShowApiKey(false);
      setEnabled(true);
      showSuccess("MCP server added. Use \"Test connection\" to verify.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showError(msg);
    }
  };

  const onTestConnection = async (serverId: number) => {
    setTestingId(serverId);
    try {
      const ipc = IpcClient.getInstance();
      const result = await ipc.testMcpConnection(serverId);
      if (result.ok) {
        showSuccess("Connection successful");
        await refetchAll();
      } else {
        showError(result.error ?? "Connection failed");
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setTestingId(null);
    }
  };

  // Removed activation toggling – tools are used dynamically with consent checks

  const onSetToolConsent = async (
    serverId: number,
    toolName: string,
    consent: "ask" | "always" | "denied",
  ) => {
    await updateToolConsent(serverId, toolName, consent);
    setConsents((prev) => ({ ...prev, [`${serverId}:${toolName}`]: consent }));
  };
  const onDeleteServer = async (serverId: number) => {
    try {
      await deleteServer(serverId);
      await refetchAll();
      showSuccess("MCP server removed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showError(msg);
    }
  };


  return (
    <div className="space-y-6">
      {countLabel != null && (
        <div className="text-sm font-medium text-muted-foreground">
          MCP servers: <span className="text-foreground">{countLabel}</span>
        </div>
      )}
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My MCP Server"
            />
          </div>
          <div>
            <Label>Transport</Label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value as Transport)}
              className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>
          {transport === "stdio" && (
            <>
              <div>
                <Label>Command</Label>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="node"
                />
              </div>
              <div>
                <Label>Args</Label>
                <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="path/to/mcp-server.js --flag"
                />
              </div>
            </>
          )}
          {transport === "http" && (
            <div className="col-span-2">
              <UrlInputField value={url} onChange={setUrl} />
            </div>
          )}
          <div className="col-span-2 space-y-1.5">
            <Label>API Key (optional)</Label>
            <div className="relative">
              <Input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-... or your server's API key"
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3"
                onClick={() => setShowApiKey((v) => !v)}
              >
                {showApiKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Only required for servers that need authentication. Stored
              locally on your machine.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <Label>Enabled</Label>
          </div>
        </div>
        {mcpAtFreeLimit && (
          <div className="rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200">
            Free tier is limited to 1 MCP server.{" "}
            <button
              type="button"
              onClick={() => handleUpgrade()}
              className="font-medium underline hover:no-underline"
            >
              Upgrade to Pro
            </button>{" "}
            for unlimited MCP servers.
          </div>
        )}
        <div>
          <Button
            onClick={onCreate}
            disabled={!name.trim() || mcpAtFreeLimit || atMaxServers}
          >
            Add server
          </Button>
          {atMaxServers && maxServers != null && (
            <p className="text-xs text-muted-foreground mt-2">
              Maximum {maxServers} {scope} MCP server{maxServers !== 1 ? "s" : ""} reached.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {servers.map((s) => {
          const isExpanded = expandedServerIds.has(s.id);
          const toolCount = (toolsByServer[s.id] || []).length;
          return (
          <div key={s.id} className="border rounded-lg p-3">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="flex items-start gap-2 min-w-0 flex-1 text-left"
                onClick={() => toggleServerExpanded(s.id)}
              >
                {isExpanded ? (
                  <ChevronsDownUp className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                ) : (
                  <ChevronsUpDown className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1">
                    <span>{s.transport}</span>
                    {s.transport === "http" && s.url ? (
                      <UrlReadOnlyRow url={s.url} />
                    ) : null}
                    {s.command ? <span className="truncate">· {s.command}</span> : null}
                    {Array.isArray(s.args) && s.args.length ? (
                      <span className="truncate">· {s.args.join(" ")}</span>
                    ) : null}
                    {toolCount > 0 ? (
                      <span>· {toolCount} tool{toolCount === 1 ? "" : "s"}</span>
                    ) : null}
                  </div>
                </div>
              </button>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onTestConnection(s.id)}
                  disabled={testingId === s.id}
                >
                  <Wifi className="h-4 w-4 mr-1" />
                  {testingId === s.id ? "Testing…" : "Test connection"}
                </Button>
                <Switch
                  checked={!!s.enabled}
                  onCheckedChange={() => toggleServerEnabled(s.id, !!s.enabled)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isDeleting}
                  onClick={() => void onDeleteServer(s.id)}
                >
                  Delete
                </Button>
              </div>
            </div>
            {isExpanded ? (
              <>
            {s.transport === "stdio" && (
              <div className="mt-3">
                <div className="text-sm font-medium mb-2">
                  Environment Variables
                </div>
                <EnvVarsEditor
                  serverId={s.id}
                  envJson={s.envJson}
                  disabled={!s.enabled}
                  isSaving={!!isUpdatingServer}
                  onSave={async (pairs) => {
                    await updateServer({
                      id: s.id,
                      envJson: arrayToEnvObject(pairs),
                    });
                  }}
                />
              </div>
            )}
            <div className="mt-3">
              <ScrollArea className="max-h-[280px] pr-2">
                <div className="space-y-2">
              {(toolsByServer[s.id] || []).map((t) => (
                <div key={t.name} className="border rounded p-2">
                  <div className="flex items-center gap-4">
                    <div className="font-mono text-sm truncate">{t.name}</div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={consents[`${s.id}:${t.name}`] || "ask"}
                        onValueChange={(v) =>
                          onSetToolConsent(s.id, t.name, v as any)
                        }
                      >
                        <SelectTrigger className="w-[140px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ask">Ask</SelectItem>
                          <SelectItem value="always">Always allow</SelectItem>
                          <SelectItem value="denied">Deny</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {t.description && (
                    <div className="mt-1 text-xs max-w-[500px] text-muted-foreground truncate">
                      {t.description}
                    </div>
                  )}
                </div>
              ))}
              {(toolsByServer[s.id] || []).length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No tools discovered.
                </div>
              )}
                </div>
              </ScrollArea>
            </div>
              </>
            ) : null}
          </div>
          );
        })}
        {servers.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No servers configured yet.
          </div>
        )}
      </div>
    </div>
  );
}
