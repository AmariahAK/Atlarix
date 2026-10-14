import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { removeMcpServerFromAllCaches } from "@/hooks/mcpQueryCache";
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
import { McpOAuthServerActions } from "@/components/McpOAuthPrompt";
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
  ChevronRight,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Rix } from "@/components/atlarix/Rix";
import {
  UrlInputField,
  UrlReadOnlyRow,
} from "@/components/settings/UrlDisplayField";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
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
  scope = "workspace",
  appId,
}: {
  scope?: "workspace";
  appId?: number | null;
} = {}) {
  const filter =
    scope === "workspace" && appId != null
      ? { scope: "workspace" as const, appId }
      : undefined;
  const queryClient = useQueryClient();
  const {
    servers,
    toolsByServer,
    toolsErrorsByServer,
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
  const { settings, updateSettings } = useSettings();
  const [sandboxDiag, setSandboxDiag] = useState<{
    platform: string;
    firejailFound: boolean;
    firejailPath: string | null;
    sandboxWouldBeActive: boolean;
  } | null>(null);
  // The limit counts servers that are ON (this folder's and the account's).
  const { data: limit } = useQuery({
    queryKey: ["mcp", "limit", appId ?? null],
    queryFn: () => IpcClient.getInstance().getMcpLimit(appId ?? null),
  });

  const [consents, setConsents] = useState<Record<string, any>>({});
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<string>("");
  const [url, setUrl] = useState("");
  const [httpAuthMode, setHttpAuthMode] = useState<"api_key" | "oauth">(
    "api_key",
  );
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const atMaxServers = !!limit && enabled && limit.on >= limit.max;
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

  useEffect(() => {
    void IpcClient.getInstance()
      .getMcpSandboxDiagnostics()
      .then(setSandboxDiag)
      .catch(() => setSandboxDiag(null));
  }, [settings?.sandboxMcpStdio, settings?.mcpStdioFirejail?.customBinaryPath]);

  const onCreate = async () => {
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
      const created = await createServer({
        name,
        transport,
        command: command || null,
        args: parsedArgs,
        url: url || null,
        apiKey:
          transport === "http" && httpAuthMode === "oauth"
            ? null
            : apiKey.trim() || null,
        authType:
          transport === "http" && httpAuthMode === "oauth"
            ? "oauth"
            : undefined,
        enabled,
        scope: "workspace",
        appId: appId ?? null,
      });
      setName("");
      setCommand("");
      setArgs("");
      setUrl("");
      setApiKey("");
      setShowApiKey(false);
      if (
        transport === "http" &&
        httpAuthMode === "oauth" &&
        created &&
        typeof created === "object" &&
        "id" in created
      ) {
        await IpcClient.getInstance().startMcpOAuth({
          serverId: (created as { id: number }).id,
        });
        showInfo("Opening browser to sign in to your MCP server…");
      } else {
        showSuccess("MCP server added");
      }
      setEnabled(true);
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
      removeMcpServerFromAllCaches(queryClient, serverId);
      setExpandedServerIds((prev) => {
        if (!prev.has(serverId)) return prev;
        const next = new Set(prev);
        next.delete(serverId);
        return next;
      });
      await refetchAll();
      showSuccess("MCP server removed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|already removed/i.test(msg)) {
        removeMcpServerFromAllCaches(queryClient, serverId);
        await refetchAll();
        showSuccess("MCP server removed");
        return;
      }
      showError(msg);
    }
  };

  return (
    <div className="space-y-6">
      <details className="space-y-2">
        <summary className="text-sm text-muted-foreground cursor-pointer select-none">
          Add manually
        </summary>
        <div className="grid grid-cols-2 gap-3 pt-2">
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
            <>
              <div className="col-span-2 space-y-1.5">
                <Label>URL</Label>
                <UrlInputField
                  value={url}
                  onChange={setUrl}
                  placeholder="https://example.com/mcp"
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>HTTP authentication</Label>
                <select
                  value={httpAuthMode}
                  onChange={(e) =>
                    setHttpAuthMode(e.target.value as "api_key" | "oauth")
                  }
                  className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
                >
                  <option value="api_key">API key (Bearer token)</option>
                  <option value="oauth">OAuth (browser sign-in)</option>
                </select>
              </div>
            </>
          )}
          {!(transport === "http" && httpAuthMode === "oauth") && (
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
          )}
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <Label>Enabled</Label>
          </div>
        </div>
        <div>
          <Button onClick={onCreate} disabled={!name.trim() || atMaxServers}>
            Add server
          </Button>
          {atMaxServers && limit && (
            <p className="text-xs text-muted-foreground mt-2">
              {limit.max} servers are already on.
            </p>
          )}
        </div>
      </details>

      <div className="space-y-3">
        {servers.length > 0 && <div className="text-sm font-medium">On this computer</div>}
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
                      {s.command ? (
                        <span className="truncate">· {s.command}</span>
                      ) : null}
                      {Array.isArray(s.args) && s.args.length ? (
                        <span className="truncate">· {s.args.join(" ")}</span>
                      ) : null}
                      {toolCount > 0 ? (
                        <span>
                          · {toolCount} tool{toolCount === 1 ? "" : "s"}
                        </span>
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
                    onCheckedChange={() =>
                      toggleServerEnabled(s.id, !!s.enabled)
                    }
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
                  {s.authType === "oauth" && (
                    <div className="mt-3">
                      <McpOAuthServerActions
                        serverId={s.id}
                        serverName={s.name}
                        oauthConnected={s.oauthConnected}
                        onChanged={() => void refetchAll()}
                      />
                    </div>
                  )}
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
                              <div className="font-mono text-sm truncate">
                                {t.name}
                              </div>
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
                                    <SelectItem value="always">
                                      Always allow
                                    </SelectItem>
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
                            {toolsErrorsByServer[s.id]?.needsOAuth
                              ? "Sign-in required — use Connect above to authorize this server."
                              : toolsErrorsByServer[s.id]?.error
                                ? toolsErrorsByServer[s.id].error
                                : "No tools discovered."}
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
          <div className="flex flex-col items-center gap-1 py-4 text-sm text-muted-foreground">
            <Rix size={56} />
            Nothing on this computer for this folder yet.
          </div>
        )}
      </div>

      {/*
        ADVANCED, AND LAST.

        This block used to be the FIRST thing on the MCP page — above "Name",
        above the server list. It is Linux-only stdio-sandbox plumbing (a
        firejail toggle, a network toggle, and a custom binary path), so on
        macOS and Windows the first three controls a user met were inert, and on
        Linux they preceded the thing they were there to do.

        Now it sits below the servers, collapsed. `<details>` rather than a
        JS disclosure so it is keyboard-operable and its content is real DOM
        either way; the diagnostic line inside already reports the platform, so
        an interested reader on macOS still gets a straight answer.
      */}
      <details className="group rounded-lg border border-border/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>Advanced — stdio MCP sandbox (Linux)</span>
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
        </summary>
        <div className="px-4 pb-4">
          <div className="rounded-lg border border-border/60 p-4 space-y-3">
            <div className="text-sm font-medium">Stdio MCP sandbox (Linux)</div>
            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="sandbox-mcp-stdio"
                className="text-sm text-muted-foreground"
              >
                Wrap stdio MCP servers in firejail when available
              </Label>
              <Switch
                id="sandbox-mcp-stdio"
                checked={settings?.sandboxMcpStdio === true}
                onCheckedChange={(checked) =>
                  updateSettings({ sandboxMcpStdio: checked })
                }
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="firejail-net"
                className="text-sm text-muted-foreground"
              >
                Allow network inside sandbox
              </Label>
              <Switch
                id="firejail-net"
                disabled={!settings?.sandboxMcpStdio}
                checked={settings?.mcpStdioFirejail?.allowNetwork === true}
                onCheckedChange={(checked) =>
                  updateSettings({
                    mcpStdioFirejail: {
                      ...settings?.mcpStdioFirejail,
                      allowNetwork: checked,
                    },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label
                htmlFor="firejail-path"
                className="text-xs text-muted-foreground"
              >
                Custom firejail binary path (optional)
              </Label>
              <Input
                id="firejail-path"
                disabled={!settings?.sandboxMcpStdio}
                placeholder="/usr/bin/firejail"
                value={settings?.mcpStdioFirejail?.customBinaryPath ?? ""}
                onChange={(e) =>
                  updateSettings({
                    mcpStdioFirejail: {
                      ...settings?.mcpStdioFirejail,
                      customBinaryPath: e.target.value || undefined,
                    },
                  })
                }
              />
            </div>
            {sandboxDiag ? (
              <p className="text-xs text-muted-foreground">
                {sandboxDiag.platform !== "linux"
                  ? "Firejail sandbox applies on Linux only; stdio spawns are unchanged on this platform."
                  : sandboxDiag.sandboxWouldBeActive
                    ? `Sandbox active (firejail: ${sandboxDiag.firejailPath}).`
                    : settings?.sandboxMcpStdio
                      ? sandboxDiag.firejailFound
                        ? "Firejail found but sandbox is off — enable the toggle above."
                        : "Firejail not found. Install with your package manager (e.g. apt install firejail)."
                      : "Sandbox disabled."}
              </p>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  );
}
