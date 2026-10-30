/**
 * `plugins:*` — the one place every surface installs and manages plugins from:
 * the app's Settings → Plugins (renderer), and the CLI's /plugins, which ACP and
 * VS Code reach through the CLI (it drives these same handlers in-process).
 *
 * A preview lives HERE, keyed by its staging id, and `plugins:commit` takes only
 * the id and the person's answers. A caller can never hand back a preview of its
 * own — the file hashes and runnables it would confirm are the ones this process
 * computed and showed.
 *
 * The agent has no path to any of this: these are UI calls, not tools.
 */

import { broadcastToAllWindows } from "@/ipc/utils/broadcast_all_windows";
import {
  modCommands,
  modProblems,
  modsRenderPane,
  modsUiAction,
  modUiEvents,
  openModPanes,
  type ModUiEvent,
} from "@/lib/plugins/mod-host";
import type { IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { listPluginCommands } from "@/lib/plugins/commands";
import { describeSource } from "@/lib/plugins/source";
import {
  approvePluginRunnables,
  commitPluginInstall,
  discardPluginInstall,
  preparePluginInstall,
  removePlugin,
  reviewPluginRunnables,
  setPluginEnabled,
  setPluginFolders,
  setPluginModel,
  sweepPluginStaging,
  type PluginInstallPreview,
} from "@/lib/plugins/install";
import { describeRunnables, readPluginContents } from "@/lib/plugins/manifest";
import { removePluginMcpRows } from "@/lib/plugins/mcp-sync";
import { pluginDir } from "@/lib/plugins/paths";
import { loadPlugins, verifyInstalledPlugin } from "@/lib/plugins/registry";
import { readPluginRecords, type PluginRecord } from "@/lib/plugins/store";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("plugin_handlers");
const handle = createLoggedHandler(logger);

/** What a surface shows for a preview: everything but the file hashes. */
export interface PluginPreviewView {
  stagingId: string;
  name: string;
  version: string;
  description: string;
  format: string;
  source: string;
  sha: string | null;
  skills: string[];
  agents: string[];
  commands: string[];
  /** The second confirm, in full. Empty = none needed. */
  runnables: string[];
  unsupported: string[];
  update: {
    changedFiles: string[];
    installedChanged: boolean;
    runnablesAdded: string[];
    runnablesRemoved: string[];
  } | null;
}

export interface PluginListItem {
  name: string;
  version: string;
  description: string;
  source: string;
  sha: string | null;
  enabled: boolean;
  folders: string[] | null;
  model: string | null;
  /** Null when it verifies; otherwise the one line to show. */
  problem: string | null;
  skills: string[];
  agents: string[];
  commands: string[];
  runnables: string[];
}

const previews = new Map<string, PluginInstallPreview>();

export function previewView(p: PluginInstallPreview): PluginPreviewView {
  return {
    stagingId: p.stagingId,
    name: p.contents.name,
    version: p.contents.version,
    description: p.contents.description,
    format: p.contents.format,
    source: describeSource(p.source),
    sha: p.sha ?? null,
    skills: p.contents.skills.map((s) => s.name),
    agents: p.contents.agents.map((a) => a.name),
    commands: p.contents.commands.map((c) => `/${c.name}`),
    runnables: p.runnables,
    unsupported: p.contents.unsupported,
    update: p.replaces
      ? {
          changedFiles: p.changedFiles,
          installedChanged: p.installedChanged,
          runnablesAdded: p.runnablesAdded,
          runnablesRemoved: p.runnablesRemoved,
        }
      : null,
  };
}

export function listPluginsForUi(): PluginListItem[] {
  return readPluginRecords().map((r: PluginRecord) => {
    const verified = verifyInstalledPlugin(r);
    let contents = "problem" in verified ? null : verified.contents;
    if (!contents) {
      try {
        contents = readPluginContents(pluginDir(r.name), r.name);
      } catch {
        contents = null;
      }
    }
    return {
      name: r.name,
      version: r.version,
      description: contents?.description ?? "",
      source: describeSource(r.source),
      sha: r.sha ?? null,
      enabled: r.enabled,
      folders: r.folders,
      model: r.model ?? null,
      problem: "problem" in verified ? verified.problem : null,
      skills: contents?.skills.map((s) => s.name) ?? [],
      agents: contents?.agents.map((a) => a.name) ?? [],
      commands: contents?.commands.map((c) => `/${c.name}`) ?? [],
      runnables: contents ? describeRunnables(contents) : [],
    };
  });
}

async function prepare(input: string, opts: { cwd?: string; update?: string }) {
  sweepPluginStaging();
  const preview = await preparePluginInstall(input, opts);
  previews.set(preview.stagingId, preview);
  return previewView(preview);
}

let forwardingModUi = false;

export function registerPluginHandlers(): void {
  // Mods' status, toasts and panes, to every window (the CLI, in-process, listens
  // to `modUiEvents` itself).
  if (!forwardingModUi) {
    forwardingModUi = true;
    modUiEvents.on("ui", (e: ModUiEvent) => broadcastToAllWindows("mods:ui", e));
  }

  handle("plugins:list", async () => listPluginsForUi());

  handle(
    "mods:render-pane",
    async (
      _e: IpcMainInvokeEvent,
      { plugin, id, workspacePath }: { plugin: string; id: string; workspacePath?: string | null },
    ) => modsRenderPane({ workspacePath: workspacePath ?? null }, plugin, id),
  );

  handle(
    "mods:action",
    async (
      _e: IpcMainInvokeEvent,
      { plugin, action, workspacePath }: { plugin: string; action: string; workspacePath?: string | null },
    ) => modsUiAction({ workspacePath: workspacePath ?? null }, plugin, action),
  );

  handle("mods:open-panes", async () => openModPanes());

  handle(
    "plugins:commands",
    async (
      _e: IpcMainInvokeEvent,
      { workspacePath }: { workspacePath?: string | null },
    ) => {
      const markdown = listPluginCommands(workspacePath ?? null).map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint ?? null,
        plugin: c.plugin,
      }));
      // Commands a mod registered (its `command.run` answers them).
      const fromMods = (await modCommands({ workspacePath: workspacePath ?? null }))
        .filter((c) => !markdown.some((m) => m.name === c.name))
        .map((c) => ({ name: c.name, description: c.description, argumentHint: null, plugin: c.plugin }));
      return [...markdown, ...fromMods];
    },
  );

  handle(
    "plugins:problems",
    async (
      _e: IpcMainInvokeEvent,
      { workspacePath }: { workspacePath?: string | null },
    ) => [...loadPlugins(workspacePath ?? null).problems, ...modProblems()],
  );

  handle(
    "plugins:prepare",
    async (
      _e: IpcMainInvokeEvent,
      { source, cwd }: { source: string; cwd?: string },
    ) => prepare(source, { cwd }),
  );

  handle(
    "plugins:prepare-update",
    async (_e: IpcMainInvokeEvent, { name }: { name: string }) =>
      prepare("", { update: name }),
  );

  handle(
    "plugins:commit",
    async (
      _e: IpcMainInvokeEvent,
      {
        stagingId,
        runnablesConfirmed,
        folders,
      }: {
        stagingId: string;
        runnablesConfirmed: boolean;
        folders?: string[] | null;
      },
    ) => {
      const preview = previews.get(stagingId);
      if (!preview)
        throw new Error("That install is no longer staged; start again");
      previews.delete(stagingId);
      const record = commitPluginInstall(preview, {
        runnablesConfirmed,
        folders,
      });
      return { name: record.name };
    },
  );

  handle(
    "plugins:discard",
    async (_e: IpcMainInvokeEvent, { stagingId }: { stagingId: string }) => {
      previews.delete(stagingId);
      discardPluginInstall({ stagingId });
    },
  );

  handle(
    "plugins:remove",
    async (_e: IpcMainInvokeEvent, { name }: { name: string }) => {
      const removed = removePlugin(name);
      await removePluginMcpRows(name);
      return removed;
    },
  );

  handle(
    "plugins:set-enabled",
    async (
      _e: IpcMainInvokeEvent,
      { name, enabled }: { name: string; enabled: boolean },
    ) => {
      const r = setPluginEnabled(name, enabled);
      if (!enabled) await removePluginMcpRows(name);
      return !!r;
    },
  );

  handle(
    "plugins:set-folders",
    async (
      _e: IpcMainInvokeEvent,
      { name, folders }: { name: string; folders: string[] | null },
    ) => !!setPluginFolders(name, folders),
  );

  handle(
    "plugins:set-model",
    async (
      _e: IpcMainInvokeEvent,
      { name, model }: { name: string; model: string | null },
    ) => !!setPluginModel(name, model ?? undefined),
  );

  handle(
    "plugins:review",
    async (_e: IpcMainInvokeEvent, { name }: { name: string }) =>
      reviewPluginRunnables(name),
  );

  handle(
    "plugins:approve",
    async (
      _e: IpcMainInvokeEvent,
      { name, shown }: { name: string; shown: string[] },
    ) => {
      approvePluginRunnables(name, shown);
      return true;
    },
  );
}
