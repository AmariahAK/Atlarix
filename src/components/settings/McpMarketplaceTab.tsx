/**
 * Pass 7 — MCP Marketplace tab.
 *
 * Mirrors the layout of `SkillsSettingsPage` so the two registries feel
 * consistent to users: fetch a curated JSON index, render searchable cards,
 * collect env vars in a modal, and write the resulting MCP row to the
 * local `mcp_servers` table with `from_registry = 1`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, KeyRound, Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { showError, showSuccess } from "@/lib/toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IpcClient } from "@/ipc/ipc_client";
import {
  DEFAULT_MCP_REGISTRY_URL,
  getMcpOAuthScopes,
  type McpRegistryEntry,
  type McpRegistryIndex,
} from "@/shared/mcp-registry";

interface InstalledIndexEntry {
  serverId: number;
  workspaceId: number | null;
}

interface InstallDialogState {
  entry: McpRegistryEntry;
  env: Record<string, string>;
}

const MAX_WORKSPACE_MCP = 10;
const PAGE_SIZE = 6;

export function McpMarketplaceTab({
  workspaceId,
  workspaceName,
  onChanged,
}: {
  workspaceId: number;
  workspaceName: string;
  onChanged?: () => void;
}) {
  const ipc = IpcClient.getInstance();
  const [registry, setRegistry] = useState<McpRegistryIndex | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  // Track which registry ids are already installed and at what scope, so the
  // card can show "Installed" instead of "Connect".
  const [installed, setInstalled] = useState<Map<string, InstalledIndexEntry[]>>(new Map());
  const [installDialog, setInstallDialog] = useState<InstallDialogState | null>(null);
  const [installing, setInstalling] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [workspaceCount, setWorkspaceCount] = useState(0);

  const refreshInstalled = useCallback(async () => {
    try {
      const servers = (await ipc.listMcpServers({
        scope: "workspace",
        appId: workspaceId,
      })) as Array<{
        id: number;
        registryId: string | null;
        appId: number | null;
      }>;
      const map = new Map<string, InstalledIndexEntry[]>();
      for (const s of servers) {
        if (!s.registryId) continue;
        const list = map.get(s.registryId) ?? [];
        list.push({ serverId: s.id, workspaceId: s.appId });
        map.set(s.registryId, list);
      }
      setInstalled(map);
      setWorkspaceCount(servers.length);
    } catch (e) {
      console.warn("[McpMarketplace] Failed to load installed MCPs:", e);
    }
  }, [ipc, workspaceId]);

  const fetchRegistry = useCallback(async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const res = await ipc.fetchMcpRegistry();
      if (!res.success || !res.registry) {
        setFetchError(res.error ?? "Failed to fetch registry");
        return;
      }
      setRegistry(res.registry);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [ipc]);

  useEffect(() => {
    void fetchRegistry();
    void refreshInstalled();
  }, [fetchRegistry, refreshInstalled]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const m of registry?.mcps ?? []) {
      (m.tags ?? []).forEach((t) => set.add(t));
    }
    return ["all", ...Array.from(set).sort()];
  }, [registry]);

  // Curated categories from the registry (optional field) — UI degrades to tags only.
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const m of registry?.mcps ?? []) {
      if (m.category?.trim()) set.add(m.category.trim());
    }
    return Array.from(set).sort();
  }, [registry]);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    if (!registry) return [];
    const q = search.trim().toLowerCase();
    return registry.mcps.filter((m) => {
      if (tagFilter !== "all" && !(m.tags ?? []).includes(tagFilter)) return false;
      if (categoryFilter !== "all" && m.category?.trim() !== categoryFilter) return false;
      if (!q) return true;
      const haystack = [m.name, m.description, m.id, m.category ?? "", ...(m.tags ?? [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [registry, search, tagFilter, categoryFilter]);

  useEffect(() => {
    setPage(1);
  }, [search, tagFilter, categoryFilter]);

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  }, [filtered.length]);

  const pagedFiltered = useMemo(() => {
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page, totalPages]);

  const installEntry = useCallback(
    async (entry: McpRegistryEntry, env: Record<string, string>) => {
      setInstalling(true);
      try {
        const res = await ipc.installMcpFromRegistry({
          entry,
          env,
          scope: "workspace",
          appId: workspaceId,
        });
        if (!res.success) {
          setFetchError(res.error ?? "Install failed");
          return;
        }
        setInstallDialog(null);
        await refreshInstalled();
        onChanged?.();
        if (res.needsOAuth && res.serverId != null) {
          try {
            await ipc.startMcpOAuth({
              serverId: res.serverId,
              scopes: getMcpOAuthScopes(entry),
            });
            showSuccess(`Opening browser to sign in to ${entry.name}…`);
          } catch (e) {
            setFetchError(
              e instanceof Error ? e.message : "Failed to start OAuth sign-in",
            );
          }
        } else {
          showSuccess(`Connected ${entry.name}`);
        }
      } finally {
        setInstalling(false);
      }
    },
    [ipc, refreshInstalled, onChanged, workspaceId],
  );

  const onConnect = useCallback(
    (entry: McpRegistryEntry) => {
      // True one-click for OAuth servers: no env vars to collect, so skip the
      // dialog and go straight to install + browser sign-in.
      if (entry.authType === "oauth") {
        void installEntry(entry, {});
        return;
      }
      const initialEnv: Record<string, string> = {};
      for (const v of entry.envVars ?? []) initialEnv[v.key] = "";
      setInstallDialog({ entry, env: initialEnv });
    },
    [installEntry],
  );

  const onSubmitInstall = useCallback(async () => {
    if (!installDialog) return;
    await installEntry(installDialog.entry, installDialog.env);
  }, [installDialog, installEntry]);

  const onDisconnect = useCallback(
    async (entryId: string, installList: InstalledIndexEntry[]) => {
      setDisconnectingId(entryId);
      try {
        for (const inst of installList) {
          await ipc.deleteMcpServer(inst.serverId);
        }
        showSuccess("MCP disconnected");
        await refreshInstalled();
        onChanged?.();
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e));
      } finally {
        setDisconnectingId(null);
      }
    },
    [ipc, refreshInstalled, onChanged],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search marketplace (e.g. github, slack)"
            className="pl-8"
          />
        </div>
        {allCategories.length > 0 && (
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {allCategories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={tagFilter} onValueChange={setTagFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by tag" />
          </SelectTrigger>
          <SelectContent>
            {allTags.map((t) => (
              <SelectItem key={t} value={t}>
                {t === "all" ? "All tags" : t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={fetchRegistry} disabled={fetching}>
          {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Registry: <code className="bg-muted px-1 rounded">{DEFAULT_MCP_REGISTRY_URL}</code> ·{" "}
        {registry?.mcps.length ?? 0} MCPs · {workspaceName}: {workspaceCount}/{MAX_WORKSPACE_MCP}
      </p>

      {fetchError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {fetchError}
        </div>
      )}

      <ScrollArea className="max-h-[640px] pr-2">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pb-3 pr-2">
          <div className="text-sm text-muted-foreground">
            Showing <span className="text-foreground font-medium">{pagedFiltered.length}</span> of{" "}
            <span className="text-foreground font-medium">{filtered.length}</span> MCPs
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Prev
            </Button>
            <div className="text-sm text-muted-foreground">
              Page <span className="text-foreground font-medium">{Math.min(page, totalPages)}</span> of{" "}
              <span className="text-foreground font-medium">{totalPages}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {pagedFiltered.map((entry) => {
            const installList = installed.get(entry.id) ?? [];
            const isInstalled = installList.length > 0;
            return (
              <div
                key={entry.id}
                className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium truncate">{entry.name}</span>
                      {entry.authType === "env" && (
                        <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {entry.authType === "oauth" && (
                        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-label="OAuth" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {entry.description}
                    </p>
                  </div>
                  <a
                    href={entry.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    title="Source"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div className="flex items-center flex-wrap gap-1 text-[10px] text-muted-foreground">
                  {entry.category?.trim() && (
                    <span className="rounded bg-primary/10 text-primary px-1.5 py-0.5">
                      {entry.category}
                    </span>
                  )}
                  {(entry.tags ?? []).map((t) => (
                    <span key={t} className="rounded bg-muted/60 px-1.5 py-0.5">
                      {t}
                    </span>
                  ))}
                  {typeof entry.installs === "number" && entry.installs > 0 && (
                    <span className="ml-auto">
                      {entry.installs.toLocaleString()} installs
                    </span>
                  )}
                </div>
                <div className="mt-1">
                  {isInstalled ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={disconnectingId === entry.id}
                      onClick={() => void onDisconnect(entry.id, installList)}
                    >
                      {disconnectingId === entry.id
                        ? "Disconnecting…"
                        : `Disconnect (${installList.length} place${installList.length === 1 ? "" : "s"})`}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => onConnect(entry)}
                      disabled={workspaceCount >= MAX_WORKSPACE_MCP || installing}
                    >
                      {workspaceCount >= MAX_WORKSPACE_MCP
                        ? "Capacity reached"
                        : installing
                          ? "Connecting…"
                          : entry.authType === "oauth"
                            ? "Connect & sign in"
                            : "Connect"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && !fetching && (
            <div className="col-span-full text-sm text-muted-foreground py-8 text-center">
              No MCPs match your filter.
            </div>
          )}
        </div>
      </ScrollArea>

      <Dialog open={installDialog != null} onOpenChange={(open) => !open && setInstallDialog(null)}>
        {installDialog && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Connect {installDialog.entry.name}</DialogTitle>
              <DialogDescription>
                {installDialog.entry.description}
                <br />
                <span className="text-xs">Source: {installDialog.entry.source}</span>
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Installing into workspace: <strong>{workspaceName}</strong>
              </p>

              {(installDialog.entry.envVars ?? []).length > 0 &&
                installDialog.entry.authType !== "oauth" && (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">
                    Required environment variables — stored locally, never sent to Atlarix servers.
                  </div>
                  {installDialog.entry.envVars.map((v) => (
                    <div key={v.key} className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={`env-${v.key}`} className="text-xs">
                          {v.label}{" "}
                          <code className="bg-muted px-1 rounded text-[10px]">{v.key}</code>
                        </Label>
                        {v.url && (
                          <a
                            href={v.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-primary hover:underline"
                          >
                            Get it
                          </a>
                        )}
                      </div>
                      <Input
                        id={`env-${v.key}`}
                        type={v.secret ? "password" : "text"}
                        value={installDialog.env[v.key] ?? ""}
                        placeholder={v.placeholder}
                        onChange={(e) =>
                          setInstallDialog({
                            ...installDialog,
                            env: { ...installDialog.env, [v.key]: e.target.value },
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              {installDialog.entry.authType === "oauth" && (
                <p className="text-xs text-muted-foreground">
                  After install, your browser will open to sign in to this remote MCP
                  server. Credentials are stored locally on this device.
                </p>
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setInstallDialog(null)} disabled={installing}>
                Cancel
              </Button>
              <Button onClick={onSubmitInstall} disabled={installing}>
                {installing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Installing…
                  </>
                ) : (
                  "Install"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <p className="text-xs text-muted-foreground">
        Pro connectors (Slack, Jira, Sentry, etc.) install as standard MCP servers from this
        registry. Manage their credentials per-entry above; rotate by removing and reconnecting.
      </p>
    </div>
  );
}
