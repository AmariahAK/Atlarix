import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { ArrowLeft, Folder, Sparkles } from "lucide-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { IpcClient } from "@/ipc/ipc_client";
import { showError, showSuccess } from "@/lib/toast";
import { useAuth } from "@/lib/auth/useAuth";
import { useUpgrade } from "@/hooks/useUpgrade";

type SkillManifestFile = { name: string; url: string };
type SkillManifestEntry = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  compatibleModes: string[];
  files: SkillManifestFile[];
};

type SkillRegistryIndex = {
  version: string;
  updatedAt?: string;
  skills: SkillManifestEntry[];
};

type InstalledSkillRow = {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  tags: string[];
  compatibleModes: string[];
  installedAt: string | Date;
  scope: "global" | "workspace";
  workspacePath: string | null;
  cachedFiles: Array<{ name: string; localPath: string }>;
};

const OFFICIAL_REGISTRY_URL =
  "https://raw.githubusercontent.com/AmariahAK/atlarix-skills/main/index.json";

const MAX_WORKSPACE = 10;
const PAGE_SIZE = 6;

function normalizeModes(modes: unknown): string[] {
  if (!Array.isArray(modes)) return [];
  return modes.map((m) => String(m));
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t));
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function WorkspaceSkillsCard({
  workspace,
  installed,
  onRemove,
}: {
  workspace: { id: number; name: string; path: string };
  installed: InstalledSkillRow[];
  onRemove: (row: InstalledSkillRow) => Promise<void>;
}) {
  return (
    <Accordion type="single" collapsible className="w-full">
      <AccordionItem value={`ws:${workspace.path}`} className="border rounded-lg">
        <AccordionTrigger className="px-4">
          <div className="flex items-center gap-3 min-w-0 w-full pr-2">
            <Folder className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{workspace.name}</div>
              <div className="text-xs text-muted-foreground truncate">{workspace.path}</div>
            </div>
            <Badge variant="outline" className="shrink-0">
              {installed.length}/{MAX_WORKSPACE}
            </Badge>
          </div>
        </AccordionTrigger>
        <AccordionContent className="px-4">
          {installed.length === 0 ? (
            <div className="text-sm text-muted-foreground">No workspace skills installed.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {installed.map((row) => (
                <InstalledSkillCard
                  key={`${row.id}:workspace:${workspace.path}`}
                  row={row}
                  onRemove={() => onRemove(row)}
                />
              ))}
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function SkillCard({
  skill,
  installed,
  onInstallWorkspace,
  workspaceInstallDisabled,
  installErrorWorkspace,
  isInstallingWorkspace,
}: {
  skill: SkillManifestEntry;
  installed: boolean;
  onInstallWorkspace: () => void;
  workspaceInstallDisabled: boolean;
  installErrorWorkspace?: string | null;
  isInstallingWorkspace: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="font-medium truncate">{skill.name}</div>
            <Badge variant="secondary" className="shrink-0">
              v{skill.version}
            </Badge>
          </div>
          <div className="text-sm text-muted-foreground line-clamp-2 mt-1">
            {skill.description}
          </div>
        </div>
        {installed && (
          <Badge variant="outline" className="shrink-0">
            Installed
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {normalizeTags(skill.tags)
          .slice(0, 8)
          .map((t) => (
            <Badge key={t} variant="outline">
              {t}
            </Badge>
          ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {normalizeModes(skill.compatibleModes).map((m) => (
          <Badge key={m} variant="secondary">
            {m}
          </Badge>
        ))}
      </div>

      <div className="pt-2 space-y-1">
        <Button
          onClick={onInstallWorkspace}
          disabled={workspaceInstallDisabled || installed || isInstallingWorkspace}
          className="w-full"
          variant={installed ? "outline" : "default"}
        >
          {installed
            ? "Installed"
            : isInstallingWorkspace
              ? "Installing..."
              : "Install to workspace"}
        </Button>
        {workspaceInstallDisabled ? (
          <div className="text-xs text-muted-foreground">
            Open a workspace from the welcome screen or sidebar to install skills.
          </div>
        ) : installErrorWorkspace ? (
          <div className="text-xs text-destructive">{installErrorWorkspace}</div>
        ) : null}
      </div>
    </div>
  );
}

function InstalledSkillCard({
  row,
  onRemove,
}: {
  row: InstalledSkillRow;
  onRemove: () => Promise<void>;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="font-medium truncate">{row.name}</div>
            <Badge variant="secondary" className="shrink-0">
              v{row.version}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground mt-1 truncate">
            {row.author}
          </div>
        </div>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm">
              Remove
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove skill?</AlertDialogTitle>
              <AlertDialogDescription>
                This will uninstall <span className="font-medium">{row.name}</span> and delete its cached files for this scope.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  void onRemove();
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="flex flex-wrap gap-1.5 mt-3">
        {normalizeModes(row.compatibleModes).map((m) => (
          <Badge key={m} variant="secondary">
            {m}
          </Badge>
        ))}
      </div>
    </div>
  );
}

export function SkillsSettingsPage() {
  const router = useRouter();
  const navigate = useNavigate();
  const ipc = IpcClient.getInstance();
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
  const workspacePath = workspaceInfo?.path ?? "";
  const workspaceName = workspaceInfo?.name ?? "Workspace";
  const currentWorkspace =
    selectedAppId && workspacePath
      ? { id: selectedAppId, name: workspaceName, path: workspacePath }
      : null;

  const { status, loading: authLoading } = useAuth();
  const { handleUpgrade, isLoading: upgradeLoading } = useUpgrade();
  const plan = status?.plan ?? "free";
  const isPaid = plan === "pro";

  const [registryUrl, setRegistryUrl] = useState(OFFICIAL_REGISTRY_URL);
  const [registry, setRegistry] = useState<SkillRegistryIndex | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [installedWorkspace, setInstalledWorkspace] = useState<InstalledSkillRow[]>([]);
  const [orphanedSkills, setOrphanedSkills] = useState<InstalledSkillRow[]>([]);

  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [modeFilter, setModeFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const [activeSearch, setActiveSearch] = useState("");

  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});

  const [repoSkillsInfo, setRepoSkillsInfo] = useState<{
    total: number;
    priority: number;
    isWorkforce: boolean;
  } | null>(null);

  const refreshInstalled = useCallback(async () => {
    if (!workspacePath) {
      setInstalledWorkspace([]);
    } else {
      const wsRows = (await ipc.skillsList({
        scope: "workspace",
        workspacePath,
      })) as InstalledSkillRow[];
      setInstalledWorkspace(wsRows ?? []);
    }
    try {
      const orphans = (await ipc.skillsListOrphaned()) as InstalledSkillRow[];
      setOrphanedSkills(orphans ?? []);
    } catch {
      setOrphanedSkills([]);
    }
  }, [ipc, workspacePath]);

  useEffect(() => {
    if (!selectedAppId) {
      setRepoSkillsInfo(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await ipc.listRepoSkills(selectedAppId);
        const total = res.skills.length;
        if (total === 0) {
          if (!cancelled) setRepoSkillsInfo(null);
          return;
        }
        const priority = res.skills.filter((s) => s.priority).length;
        if (!cancelled) {
          setRepoSkillsInfo({ total, priority, isWorkforce: res.isWorkforce });
        }
      } catch (e) {
        console.warn(`Failed to load repo skills for workspace ${selectedAppId}:`, e);
        if (!cancelled) setRepoSkillsInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ipc, selectedAppId]);

  useEffect(() => {
    if (!isPaid) return;
    void refreshInstalled();
  }, [refreshInstalled, isPaid]);

  const onFetchRegistry = useCallback(async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const idx = (await ipc.skillsFetchRegistry(registryUrl)) as SkillRegistryIndex;
      setRegistry(idx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFetchError(msg);
    } finally {
      setFetching(false);
    }
  }, [ipc, registryUrl]);

  const installedLookup = useMemo(() => {
    return new Set(installedWorkspace.map((s) => s.id));
  }, [installedWorkspace]);

  const allTags = useMemo(() => {
    const skills = registry?.skills ?? [];
    return uniq(skills.flatMap((s) => normalizeTags(s.tags))).sort((a, b) => a.localeCompare(b));
  }, [registry]);

  const allModes = useMemo(() => {
    const skills = registry?.skills ?? [];
    return uniq(skills.flatMap((s) => normalizeModes(s.compatibleModes))).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [registry]);

  const filteredSkills = useMemo(() => {
    const skills = registry?.skills ?? [];
    const q = search.trim().toLowerCase();
    return skills.filter((s) => {
      if (q) {
        const hay = `${s.name} ${s.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (tagFilter) {
        if (!normalizeTags(s.tags).includes(tagFilter)) return false;
      }
      if (modeFilter) {
        if (!normalizeModes(s.compatibleModes).includes(modeFilter)) return false;
      }
      return true;
    });
  }, [registry, search, tagFilter, modeFilter]);

  useEffect(() => {
    setPage(1);
  }, [search, tagFilter, modeFilter]);

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredSkills.length / PAGE_SIZE));
  }, [filteredSkills.length]);

  const pagedSkills = useMemo(() => {
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredSkills.slice(start, start + PAGE_SIZE);
  }, [filteredSkills, page, totalPages]);

  const workspaceInstallDisabled = !currentWorkspace;

  const activeQuery = activeSearch.trim().toLowerCase();
  const installedWorkspaceFiltered = useMemo(() => {
    if (!activeQuery) return installedWorkspace;
    return installedWorkspace.filter((s) => {
      const hay = `${s.name} ${s.author} ${s.id}`.toLowerCase();
      return hay.includes(activeQuery);
    });
  }, [installedWorkspace, activeQuery]);

  const install = useCallback(
    async (skill: SkillManifestEntry, wsPath: string) => {
      const key = `${skill.id}:workspace`;
      setInstallErrors((prev) => ({ ...prev, [key]: "" }));
      setInstallingKey(key);
      try {
        await ipc.skillsInstall({
          skill,
          scope: "workspace",
          workspacePath: wsPath,
        });
        showSuccess(`Installed ${skill.name} (workspace)`);
        await refreshInstalled();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Slot limit UX: surface clear inline error
        if (msg.includes("limit reached")) {
          const limitLabel = `Workspace limit reached (${MAX_WORKSPACE}/${MAX_WORKSPACE})`;
          setInstallErrors((prev) => ({
            ...prev,
            [key]: `${limitLabel} — remove a skill first.`,
          }));
        } else {
          setInstallErrors((prev) => ({ ...prev, [key]: msg }));
        }
        showError(msg);
      } finally {
        setInstallingKey(null);
      }
    },
    [ipc, refreshInstalled],
  );

  const remove = useCallback(
    async (row: InstalledSkillRow) => {
      try {
        await ipc.skillsUninstall({
          skillId: row.id,
          scope: row.scope,
          workspacePath: row.scope === "workspace" ? (row.workspacePath ?? undefined) : undefined,
        });
        showSuccess(`Removed ${row.name}`);
        await refreshInstalled();
      } catch (e) {
        showError(e);
      }
    },
    [ipc, refreshInstalled],
  );

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="max-w-5xl mx-auto px-8 py-6 pb-20 space-y-8">
        <Button
          onClick={() => router.navigate({ to: "/settings" })}
          variant="outline"
          size="sm"
          className="mb-4 bg-(--background-lightest) py-5"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>

        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-primary" />
            <h1 className="text-3xl font-bold text-foreground">Skills</h1>
          </div>
          <p className="text-muted-foreground mt-1">
            Browse and install skills for your <strong>current workspace</strong> only (max{" "}
            {MAX_WORKSPACE} per workspace).
          </p>
        </div>

        {!selectedAppId ? (
          <p className="text-sm text-muted-foreground py-4">
            Open a workspace from the welcome screen or sidebar to manage skills for that project.
          </p>
        ) : null}

        {/* Tier gate — informational, mirroring the MCP marketplace tab. Landing
            here on Free must never trigger a checkout; upgrading is an explicit
            click on the button below. */}
        {!authLoading && !isPaid ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-6 space-y-3 text-sm">
            <div className="font-medium text-foreground">Skills are a Pro feature</div>
            <p className="text-muted-foreground">
              Installing Agent Behaviors from the{" "}
              <span className="font-medium">skills registry</span> requires Pro. On Free, the agent
              still reads project instructions from <code>.atlarix/atlarix.md</code> and any
              behaviors you commit under <code>.atlarix/skills/</code> in the repo itself.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  void handleUpgrade();
                }}
                disabled={upgradeLoading}
              >
                {upgradeLoading ? "Opening..." : "Upgrade"}
              </Button>
              <Button variant="outline" onClick={() => navigate({ to: "/account" })}>
                Manage plan
              </Button>
            </div>
          </div>
        ) : null}

        {(!authLoading && !isPaid) || !selectedAppId ? null : (
        <>
        <Accordion type="multiple" defaultValue={["registry", "browse", "active"]} className="w-full">
          <AccordionItem value="registry" className="border rounded-xl">
            <AccordionTrigger className="px-6">
              <div className="text-base font-semibold">Registry & Filters</div>
            </AccordionTrigger>
            <AccordionContent className="px-6">
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2 space-y-2">
                    <Label>Registry URL</Label>
                    <Input value={registryUrl} onChange={(e) => setRegistryUrl(e.target.value)} />
                  </div>
                  <div className="flex items-end">
                    <Button onClick={onFetchRegistry} disabled={fetching} className="w-full">
                      {fetching ? "Fetching..." : "Fetch skills"}
                    </Button>
                  </div>
                </div>

                {fetchError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                    {fetchError}
                  </div>
                ) : null}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-2">
                    <Label>Search</Label>
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search skills..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Filter by tag</Label>
                    <select
                      value={tagFilter}
                      onChange={(e) => setTagFilter(e.target.value)}
                      className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
                    >
                      <option value="">All</option>
                      {allTags.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>Filter by mode</Label>
                    <select
                      value={modeFilter}
                      onChange={(e) => setModeFilter(e.target.value)}
                      className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
                    >
                      <option value="">All</option>
                      {allModes.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {currentWorkspace ? (
                  <div className="space-y-2">
                    <Label>Current workspace</Label>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Folder className="w-4 h-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium text-foreground truncate">{currentWorkspace.name}</div>
                        <div className="text-xs truncate">{currentWorkspace.path}</div>
                      </div>
                    </div>
                    {repoSkillsInfo ? (
                      <div className="text-xs text-muted-foreground">
                        <span>
                          {repoSkillsInfo.total} repo skill
                          {repoSkillsInfo.total === 1 ? "" : "s"} from{" "}
                          <code className="text-[10px]">.atlarix/skills/</code>
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <Tabs defaultValue="browse" className="pt-2">
          <TabsList>
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="active">Active Skills</TabsTrigger>
          </TabsList>

          <TabsContent value="browse">
            <div className="space-y-4">
              {!registry ? (
                <div className="text-sm text-muted-foreground">
                  Fetch the registry to browse available skills.
                </div>
              ) : (
                <Accordion type="single" collapsible defaultValue="browseList" className="w-full">
                  <AccordionItem value="browseList" className="border rounded-xl">
                    <AccordionTrigger className="px-6">
                      <div className="text-base font-semibold">Browse</div>
                    </AccordionTrigger>
                    <AccordionContent className="px-6">
                      <ScrollArea className="h-[680px]">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pr-3 pb-3">
                    <div className="text-sm text-muted-foreground">
                      Showing <span className="text-foreground font-medium">{pagedSkills.length}</span>{" "}
                      of <span className="text-foreground font-medium">{filteredSkills.length}</span>{" "}
                      skills
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search skills..."
                        className="h-8 sm:w-[220px]"
                      />
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
                          Page{" "}
                          <span className="text-foreground font-medium">
                            {Math.min(page, totalPages)}
                          </span>{" "}
                          of <span className="text-foreground font-medium">{totalPages}</span>
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
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pr-3 pb-6">
                    {pagedSkills.map((s) => {
                      const kW = `${s.id}:workspace`;
                      return (
                        <SkillCard
                          key={s.id}
                          skill={s}
                          installed={installedLookup.has(s.id)}
                          workspaceInstallDisabled={workspaceInstallDisabled}
                          onInstallWorkspace={() => {
                            if (!workspacePath) return;
                            void install(s, workspacePath);
                          }}
                          installErrorWorkspace={installErrors[kW] || null}
                          isInstallingWorkspace={installingKey === kW}
                        />
                      );
                    })}
                    {filteredSkills.length === 0 ? (
                      <div className="text-sm text-muted-foreground">
                        No skills match your filters.
                      </div>
                    ) : null}
                  </div>
                      </ScrollArea>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </div>
          </TabsContent>

          <TabsContent value="active">
            <div className="space-y-3">
              <Label>Search installed skills</Label>
              <Input
                value={activeSearch}
                onChange={(e) => setActiveSearch(e.target.value)}
                placeholder="Search installed skills..."
              />
            </div>
            {currentWorkspace ? (
              <WorkspaceSkillsCard
                workspace={currentWorkspace}
                installed={installedWorkspaceFiltered}
                onRemove={remove}
              />
            ) : null}
          </TabsContent>
        </Tabs>

        {orphanedSkills.length > 0 && (
          <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Unlinked workspace skills</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Installed for a workspace path that no longer exists. Remove them to free skill slots.
              </p>
            </div>
            <div className="space-y-2">
              {orphanedSkills.map((row) => (
                <div
                  key={`${row.id}:${row.workspacePath ?? ""}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 p-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{row.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {row.workspacePath ?? "unknown path"}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void remove(row)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}

