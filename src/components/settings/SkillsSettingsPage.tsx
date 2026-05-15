import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Folder, Sparkles } from "lucide-react";
import { useNavigate, useRouter } from "@tanstack/react-router";

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

const MAX_GLOBAL = 5;
const MAX_WORKSPACE = 5;
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
  onInstallGlobal,
  onInstallWorkspace,
  workspaceSelect,
  selectedWorkspacePath,
  workspaceInstallDisabled,
  installErrorGlobal,
  installErrorWorkspace,
  isInstallingGlobal,
  isInstallingWorkspace,
}: {
  skill: SkillManifestEntry;
  installed: { global: boolean; workspace: boolean };
  onInstallGlobal: () => void;
  onInstallWorkspace: () => void;
  workspaceSelect?: React.ReactNode;
  selectedWorkspacePath?: string;
  workspaceInstallDisabled: boolean;
  installErrorGlobal?: string | null;
  installErrorWorkspace?: string | null;
  isInstallingGlobal: boolean;
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
        {(installed.global || installed.workspace) && (
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

      <div className="grid grid-cols-2 gap-2 pt-2">
        <div className="space-y-1">
          <Button
            onClick={onInstallGlobal}
            disabled={installed.global || isInstallingGlobal}
            className="w-full"
            variant={installed.global ? "outline" : "default"}
          >
            {installed.global ? "Installed (Global)" : isInstallingGlobal ? "Installing..." : "Install Global"}
          </Button>
          {installErrorGlobal ? (
            <div className="text-xs text-destructive">{installErrorGlobal}</div>
          ) : null}
        </div>
        <div className="space-y-1">
          <Button
            onClick={onInstallWorkspace}
            disabled={
              workspaceInstallDisabled ||
              !selectedWorkspacePath ||
              installed.workspace ||
              isInstallingWorkspace
            }
            className="w-full"
            variant={installed.workspace ? "outline" : "secondary"}
          >
            {installed.workspace
              ? "Installed (Workspace)"
              : isInstallingWorkspace
                ? "Installing..."
                : "Install for Workspace"}
          </Button>
          {!workspaceInstallDisabled ? workspaceSelect : null}
          {workspaceInstallDisabled ? (
            <div className="text-xs text-muted-foreground">
              Add a workspace to enable workspace-scoped skill installs.
            </div>
          ) : installErrorWorkspace ? (
            <div className="text-xs text-destructive">{installErrorWorkspace}</div>
          ) : null}
        </div>
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
  const { status, loading: authLoading } = useAuth();
  const { handleUpgrade, isLoading: upgradeLoading } = useUpgrade();
  const plan = status?.plan ?? "free";
  const isPaid = plan === "pro" || plan === "workforce";

  const [registryUrl, setRegistryUrl] = useState(OFFICIAL_REGISTRY_URL);
  const [registry, setRegistry] = useState<SkillRegistryIndex | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [installedGlobal, setInstalledGlobal] = useState<InstalledSkillRow[]>([]);
  const [workspaces, setWorkspaces] = useState<Array<{ id: number; name: string; path: string }>>([]);
  const [installedWorkspaceByPath, setInstalledWorkspaceByPath] = useState<
    Record<string, InstalledSkillRow[]>
  >({});

  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [modeFilter, setModeFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const [browseWorkspacePath, setBrowseWorkspacePath] = useState<string>("");
  const [activeSearch, setActiveSearch] = useState("");

  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});

  // Workforce Feature 1: repo-scoped priority skills loaded from .atlarix/skills/
  // in each workspace. We keep counts keyed by workspace id; the `isWorkforce`
  // flag is the same across workspaces but cached separately so the indicator
  // can show the upgrade hint when the priority flag is being ignored.
  const [repoSkillsByWorkspaceId, setRepoSkillsByWorkspaceId] = useState<
    Record<number, { total: number; priority: number; isWorkforce: boolean }>
  >({});

  const refreshInstalled = useCallback(async () => {
    const globalRows = (await ipc.skillsList({ scope: "global" })) as InstalledSkillRow[];
    setInstalledGlobal(globalRows);
    if (workspaces.length > 0) {
      const results = await Promise.all(
        workspaces.map(async (w) => {
          const wsRows = (await ipc.skillsList({
            scope: "workspace",
            workspacePath: w.path,
          })) as InstalledSkillRow[];
          return [w.path, wsRows] as const;
        }),
      );
      setInstalledWorkspaceByPath(Object.fromEntries(results));
    } else {
      setInstalledWorkspaceByPath({});
    }
  }, [ipc, workspaces]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const ws = await ipc.listWorkspacesWithPromptStatus();
      setWorkspaces(ws.map((w) => ({ id: w.id, name: w.name, path: w.path })));
    } catch (e) {
      // Non-fatal; workspace install UI will just be limited
      console.warn("Failed to load workspaces for Skills:", e);
    }
  }, [ipc]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // Workforce Feature 1: refresh repo-skill summaries whenever workspaces change.
  useEffect(() => {
    if (workspaces.length === 0) {
      setRepoSkillsByWorkspaceId({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<number, { total: number; priority: number; isWorkforce: boolean }> = {};
      for (const w of workspaces) {
        try {
          const res = await ipc.listRepoSkills(w.id);
          const total = res.skills.length;
          if (total === 0) continue;
          const priority = res.skills.filter((s) => s.priority).length;
          next[w.id] = { total, priority, isWorkforce: res.isWorkforce };
        } catch (e) {
          console.warn(`Failed to load repo skills for workspace ${w.id}:`, e);
        }
      }
      if (!cancelled) setRepoSkillsByWorkspaceId(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [ipc, workspaces]);

  useEffect(() => {
    if (!isPaid) return;
    void refreshInstalled();
  }, [refreshInstalled]);

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
    const globalSet = new Set(installedGlobal.map((s) => s.id));
    const wsSet = new Set(
      Object.values(installedWorkspaceByPath)
        .flat()
        .map((s) => s.id),
    );
    return { globalSet, wsSet };
  }, [installedGlobal, installedWorkspaceByPath]);

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

  const workspaceInstallDisabled = workspaces.length === 0;
  const effectiveBrowseWorkspacePath =
    browseWorkspacePath || workspaces[0]?.path || "";

  const activeQuery = activeSearch.trim().toLowerCase();
  const installedGlobalFiltered = useMemo(() => {
    if (!activeQuery) return installedGlobal;
    return installedGlobal.filter((s) => {
      const hay = `${s.name} ${s.author} ${s.id}`.toLowerCase();
      return hay.includes(activeQuery);
    });
  }, [installedGlobal, activeQuery]);

  const installedWorkspaceByPathFiltered = useMemo(() => {
    if (!activeQuery) return installedWorkspaceByPath;
    const out: Record<string, InstalledSkillRow[]> = {};
    for (const [wsPath, rows] of Object.entries(installedWorkspaceByPath)) {
      const filtered = rows.filter((s) => {
        const hay = `${s.name} ${s.author} ${s.id}`.toLowerCase();
        return hay.includes(activeQuery);
      });
      if (filtered.length > 0) out[wsPath] = filtered;
    }
    return out;
  }, [installedWorkspaceByPath, activeQuery]);

  useEffect(() => {
    if (workspaces.length === 0) return;
    if (!browseWorkspacePath) return;
    const stillExists = workspaces.some((w) => w.path === browseWorkspacePath);
    if (!stillExists) setBrowseWorkspacePath("");
  }, [workspaces, browseWorkspacePath]);

  const install = useCallback(
    async (skill: SkillManifestEntry, scope: "global" | "workspace", workspacePath?: string) => {
      const key = `${skill.id}:${scope}`;
      setInstallErrors((prev) => ({ ...prev, [key]: "" }));
      setInstallingKey(key);
      try {
        await ipc.skillsInstall({
          skill,
          scope,
          workspacePath: scope === "workspace" ? workspacePath : undefined,
        });
        showSuccess(
          scope === "workspace" && workspacePath
            ? `Installed ${skill.name} (workspace)`
            : `Installed ${skill.name} (${scope})`,
        );
        await refreshInstalled();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Slot limit UX: surface clear inline error
        if (msg.includes("limit reached")) {
          const limitLabel = scope === "global" ? `Global limit reached (${MAX_GLOBAL}/${MAX_GLOBAL})` : `Workspace limit reached (${MAX_WORKSPACE}/${MAX_WORKSPACE})`;
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
            Browse and install skills from the community registry. Install up to {MAX_GLOBAL} global skills and {MAX_WORKSPACE} per workspace.
          </p>
        </div>

        {/* Tier gate */}
        {!authLoading && !isPaid ? (
          <div className="rounded-xl border border-border bg-card p-6 space-y-3">
            <div className="font-semibold text-lg">Upgrade required</div>
            <p className="text-sm text-muted-foreground">
              Skills are available on <span className="font-medium">Pro</span> and{" "}
              <span className="font-medium">Workforce</span>.
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

        {(!authLoading && !isPaid) ? null : (
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

                <div className="space-y-2">
                  <Label>Workspaces</Label>
                  {workspaces.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      No workspaces yet. Add a workspace to enable workspace-scoped skill installs.
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Folder className="w-4 h-4" />
                      {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"} detected. Workspace
                      install buttons are enabled.
                    </div>
                  )}
                  {Object.keys(repoSkillsByWorkspaceId).length > 0 && (
                    <div className="space-y-1 pt-1">
                      {workspaces
                        .filter((w) => repoSkillsByWorkspaceId[w.id])
                        .map((w) => {
                          const info = repoSkillsByWorkspaceId[w.id];
                          const priorityHonoured = info.isWorkforce && info.priority > 0;
                          const priorityIgnored = !info.isWorkforce && info.priority > 0;
                          return (
                            <div key={w.id} className="flex items-center gap-2 text-xs">
                              <Badge variant="secondary" className="font-normal">
                                {w.name}
                              </Badge>
                              {priorityHonoured ? (
                                <span className="text-foreground/80">
                                  {info.priority} priority skill{info.priority === 1 ? "" : "s"} from <code className="text-[10px]">.atlarix/skills/</code>
                                </span>
                              ) : priorityIgnored ? (
                                <span className="text-muted-foreground">
                                  {info.total} repo skill{info.total === 1 ? "" : "s"} from <code className="text-[10px]">.atlarix/skills/</code>{" "}
                                  <span className="text-amber-600 dark:text-amber-400">(Workforce required for priority)</span>
                                </span>
                              ) : (
                                <span className="text-muted-foreground">
                                  {info.total} repo skill{info.total === 1 ? "" : "s"} from <code className="text-[10px]">.atlarix/skills/</code>
                                </span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
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
                      const kG = `${s.id}:global`;
                      const kW = `${s.id}:workspace`;
                      return (
                        <SkillCard
                          key={s.id}
                          skill={s}
                          installed={{
                            global: installedLookup.globalSet.has(s.id),
                            workspace: installedLookup.wsSet.has(s.id),
                          }}
                          workspaceInstallDisabled={workspaceInstallDisabled}
                          onInstallGlobal={() => void install(s, "global")}
                          onInstallWorkspace={() => {
                            if (!effectiveBrowseWorkspacePath) return;
                            void install(s, "workspace", effectiveBrowseWorkspacePath);
                          }}
                          selectedWorkspacePath={effectiveBrowseWorkspacePath}
                          workspaceSelect={
                            workspaces.length > 0 ? (
                              <select
                                value={effectiveBrowseWorkspacePath}
                                onChange={(e) => setBrowseWorkspacePath(e.target.value)}
                                className="w-full h-8 rounded-md border bg-transparent px-2 text-xs"
                              >
                                {workspaces.map((w) => (
                                  <option key={w.id} value={w.path}>
                                    {w.name}
                                  </option>
                                ))}
                              </select>
                            ) : null
                          }
                          installErrorGlobal={installErrors[kG] || null}
                          installErrorWorkspace={installErrors[kW] || null}
                          isInstallingGlobal={installingKey === kG}
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
            <Accordion type="multiple" defaultValue={["globalActive", "workspaceActive"]} className="w-full">
              <AccordionItem value="globalActive" className="border rounded-xl">
                <AccordionTrigger className="px-6">
                  <div className="text-base font-semibold">
                    Global ({installedGlobal.length}/{MAX_GLOBAL})
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-6">
                  {installedGlobalFiltered.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No global skills installed.</div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {installedGlobalFiltered.map((row) => (
                        <InstalledSkillCard
                          key={`${row.id}:global`}
                          row={row}
                          onRemove={() => remove(row)}
                        />
                      ))}
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="workspaceActive" className="border rounded-xl">
                <AccordionTrigger className="px-6">
                  <div className="text-base font-semibold">Workspaces</div>
                </AccordionTrigger>
                <AccordionContent className="px-6">
                  {workspaces.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      Add a workspace to enable workspace skills.
                    </div>
                  ) : activeQuery && Object.keys(installedWorkspaceByPathFiltered).length === 0 ? (
                    <div className="text-sm text-muted-foreground">No matching workspace skills.</div>
                  ) : (
                    <ScrollArea className="h-[520px]">
                      <div className="space-y-6 pr-3 pb-6">
                        {(activeQuery
                          ? workspaces.filter((ws) => (installedWorkspaceByPathFiltered[ws.path] ?? []).length > 0)
                          : workspaces
                        ).map((ws) => (
                          <WorkspaceSkillsCard
                            key={ws.path}
                            workspace={ws}
                            installed={
                              (activeQuery
                                ? installedWorkspaceByPathFiltered[ws.path]
                                : installedWorkspaceByPath[ws.path]) ?? []
                            }
                            onRemove={remove}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </TabsContent>
        </Tabs>
        </>
        )}
      </div>
    </div>
  );
}

