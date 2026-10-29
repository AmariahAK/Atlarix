/**
 * Plugins — what the person installed, through the same `plugins:*` handlers as
 * the CLI's /plugins.
 *
 * Installing asks twice when the plugin can run anything: what it is, then every
 * hook command, MCP server, agent that runs tools and mod capability, in full.
 * Cancel is the default button on both.
 */
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { Puzzle } from "lucide-react";
import { selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { IpcClient } from "@/ipc/ipc_client";
import type {
  PluginListItem,
  PluginPreviewView,
} from "@/ipc/handlers/plugin_handlers";

type Step =
  | { kind: "what"; preview: PluginPreviewView }
  | { kind: "runs"; preview: PluginPreviewView }
  | { kind: "review"; name: string; shown: string[] }
  | { kind: "remove"; name: string };

const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );

function PreviewBody({ p }: { p: PluginPreviewView }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="text-muted-foreground font-mono text-xs break-all">
        {p.source}
        {p.sha ? ` @ ${p.sha.slice(0, 7)}` : ""}
      </div>
      {p.description ? <div>{p.description}</div> : null}
      {p.skills.length ? <div>Skills: {p.skills.join(", ")}</div> : null}
      {p.agents.length ? <div>Agents: {p.agents.join(", ")}</div> : null}
      {p.commands.length ? <div>Commands: {p.commands.join(", ")}</div> : null}
      {p.update ? (
        <div className="space-y-1">
          <div className="text-muted-foreground">
            {p.update.changedFiles.length} file(s) changed
          </div>
          {p.update.runnablesAdded.map((r) => (
            <div
              key={`+${r}`}
              className="font-mono text-xs text-amber-600 dark:text-amber-400 break-all"
            >
              + {r}
            </div>
          ))}
          {p.update.runnablesRemoved.map((r) => (
            <div
              key={`-${r}`}
              className="font-mono text-xs text-muted-foreground break-all"
            >
              - {r}
            </div>
          ))}
        </div>
      ) : null}
      {p.unsupported.map((u) => (
        <div key={u} className="text-muted-foreground">
          Won't run: {u}
        </div>
      ))}
    </div>
  );
}

function Runnables({ lines }: { lines: string[] }) {
  return (
    <div className="space-y-1 max-h-72 overflow-auto rounded-md border p-3">
      {lines.map((r) => (
        <div key={r} className="font-mono text-xs break-all">
          {r}
        </div>
      ))}
    </div>
  );
}

export function PluginsSettingsPage() {
  const ipc = IpcClient.getInstance();
  const workspace = useAtomValue(selectedWorkspaceInfoAtom);
  const workspacePath = workspace?.path ?? null;
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);

  const reload = useCallback(async () => {
    setPlugins(await ipc.listPlugins().catch(() => []));
  }, [ipc]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const cancelPreview = (p: PluginPreviewView) => {
    void ipc.discardPluginInstall(p.stagingId);
    setStep(null);
  };

  const commit = (p: PluginPreviewView, runnablesConfirmed: boolean) =>
    run(async () => {
      setStep(null);
      await ipc.commitPluginInstall({
        stagingId: p.stagingId,
        runnablesConfirmed,
      });
      setSource("");
    });

  const add = () =>
    run(async () => {
      if (!source.trim()) return;
      setStep({
        kind: "what",
        preview: await ipc.preparePluginInstall(source.trim()),
      });
    });

  const update = (name: string) =>
    run(async () => {
      const preview = await ipc.preparePluginUpdate(name);
      if (preview.update && preview.update.changedFiles.length === 0) {
        void ipc.discardPluginInstall(preview.stagingId);
        setError(`${name} is up to date.`);
        return;
      }
      setStep({ kind: "what", preview });
    });

  const here = (p: PluginListItem) =>
    !p.folders ||
    (!!workspacePath &&
      p.folders.some(
        (f) => workspacePath === f || workspacePath.startsWith(`${f}/`),
      ));

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Puzzle className="w-5 h-5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Augments</h2>
          <p className="text-sm text-muted-foreground">
            Skills, agents, commands, hooks and MCP servers you add, on every
            folder or one.
          </p>
        </div>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="owner/repo, a GitHub link, or a folder"
          aria-label="Augment source"
        />
        <Button type="submit" disabled={busy || !source.trim()}>
          Add
        </Button>
      </form>
      {error ? (
        <div className="text-sm text-muted-foreground">{error}</div>
      ) : null}

      {plugins.length === 0 ? (
        <div className="text-sm text-muted-foreground">No augments yet.</div>
      ) : (
        <div className="space-y-3">
          {plugins.map((p) => (
            <div key={p.name} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{p.name}</span>
                    {p.version ? (
                      <Badge variant="outline">v{p.version}</Badge>
                    ) : null}
                    {p.enabled && !here(p) ? (
                      <Badge variant="secondary">not in this folder</Badge>
                    ) : null}
                  </div>
                  {p.description ? (
                    <div className="text-sm text-muted-foreground">
                      {p.description}
                    </div>
                  ) : null}
                  <div className="text-xs text-muted-foreground font-mono break-all mt-1">
                    {p.source}
                    {p.sha ? ` @ ${p.sha.slice(0, 7)}` : ""}
                  </div>
                  {p.problem ? (
                    <div className="text-sm text-amber-600 dark:text-amber-400 mt-1">
                      {p.problem}
                    </div>
                  ) : null}
                </div>
                <Switch
                  checked={p.enabled}
                  aria-label={`${p.name} on`}
                  onCheckedChange={(on) =>
                    void run(() => ipc.setPluginEnabled(p.name, on))
                  }
                />
              </div>

              <div className="text-sm space-y-0.5">
                {p.skills.length ? (
                  <div>Skills: {p.skills.join(", ")}</div>
                ) : null}
                {p.agents.length ? (
                  <div>Agents: {p.agents.join(", ")}</div>
                ) : null}
                {p.commands.length ? (
                  <div>Commands: {p.commands.join(", ")}</div>
                ) : null}
              </div>
              {p.runnables.length ? <Runnables lines={p.runnables} /> : null}

              <div className="flex flex-wrap items-center gap-2">
                {workspacePath ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void run(() =>
                        ipc.setPluginFolders(
                          p.name,
                          p.folders ? null : [workspacePath],
                        ),
                      )
                    }
                  >
                    {p.folders ? "Every folder" : "Only this folder"}
                  </Button>
                ) : null}
                {p.problem?.includes("needs your OK again") ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void run(async () =>
                        setStep({
                          kind: "review",
                          name: p.name,
                          shown: await ipc.reviewPlugin(p.name),
                        }),
                      )
                    }
                  >
                    Review
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void update(p.name)}
                >
                  Update
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStep({ kind: "remove", name: p.name })}
                >
                  Remove
                </Button>
                {p.agents.length ? (
                  <Input
                    className="h-8 max-w-xs"
                    defaultValue={p.model ?? ""}
                    placeholder="Model for its agents (provider/model)"
                    aria-label={`Model for ${p.name}'s agents`}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (p.model ?? ""))
                        void run(() => ipc.setPluginModel(p.name, v || null));
                    }}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={!!step}
        onOpenChange={(open) => {
          if (open || !step) return;
          if (step.kind === "what" || step.kind === "runs")
            cancelPreview(step.preview);
          else setStep(null);
        }}
      >
        <DialogContent>
          {step?.kind === "what" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {step.preview.update ? "Update" : "Install"}{" "}
                  {step.preview.name}
                  {step.preview.version ? ` ${step.preview.version}` : ""}?
                </DialogTitle>
              </DialogHeader>
              <PreviewBody p={step.preview} />
              <DialogFooter>
                <Button
                  variant="outline"
                  autoFocus
                  onClick={() => cancelPreview(step.preview)}
                >
                  Not now
                </Button>
                <Button
                  onClick={() =>
                    step.preview.runnables.length
                      ? setStep({ kind: "runs", preview: step.preview })
                      : void commit(step.preview, false)
                  }
                >
                  {step.preview.runnables.length
                    ? "Continue"
                    : step.preview.update
                      ? "Update"
                      : "Install"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
          {step?.kind === "runs" ? (
            <>
              <DialogHeader>
                <DialogTitle>{step.preview.name} runs code</DialogTitle>
              </DialogHeader>
              <div className="text-sm">
                Once on, it can run these on this computer:
              </div>
              <Runnables lines={step.preview.runnables} />
              <div className="text-sm text-muted-foreground">
                Tool calls still ask you, as your own do.
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  autoFocus
                  onClick={() => cancelPreview(step.preview)}
                >
                  Not now
                </Button>
                <Button onClick={() => void commit(step.preview, true)}>
                  {step.preview.update ? "Update" : "Install"} and allow these
                </Button>
              </DialogFooter>
            </>
          ) : null}
          {step?.kind === "review" ? (
            <>
              <DialogHeader>
                <DialogTitle>{step.name} runs code</DialogTitle>
              </DialogHeader>
              <div className="text-sm">
                This version of Atlarix reads more of it than when you installed
                it. Once on, it can run:
              </div>
              <Runnables lines={step.shown} />
              <DialogFooter>
                <Button
                  variant="outline"
                  autoFocus
                  onClick={() => setStep(null)}
                >
                  Not now
                </Button>
                <Button
                  onClick={() =>
                    void run(async () => {
                      setStep(null);
                      await ipc.approvePlugin(step.name, step.shown);
                    })
                  }
                >
                  Allow these
                </Button>
              </DialogFooter>
            </>
          ) : null}
          {step?.kind === "remove" ? (
            <>
              <DialogHeader>
                <DialogTitle>Remove {step.name}?</DialogTitle>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  autoFocus
                  onClick={() => setStep(null)}
                >
                  Not now
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    void run(async () => {
                      setStep(null);
                      await ipc.removePlugin(step.name);
                    })
                  }
                >
                  Remove
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
