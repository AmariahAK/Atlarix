/**
 * Install, update and remove: every surface's `/plugins` and Settings → Plugins
 * call these, so the rules live in one place.
 *
 * Two steps, always:
 * 1. `preparePluginInstall` fetches into a staging folder and returns a preview:
 *    what the plugin contains, and `runnables` — every hook command, MCP server,
 *    agent that can run tools and mod capability, each IN FULL.
 * 2. `commitPluginInstall` moves it into place and writes the record. When
 *    `runnables` is non-empty it refuses unless the caller passes
 *    `runnablesConfirmed` — the second confirm the surface showed. The staged tree
 *    is re-hashed against the preview first, so what lands is what was shown.
 *
 * An update is the same two steps against the installed record, with the preview
 * also carrying what changed (files, and runnables added or removed).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import {
  describeRunnables,
  PluginManifestError,
  readPluginContents,
  runnablesDigest,
  type PluginContents,
} from "./manifest";
import { verifyPluginFiles } from "./registry";
import {
  isValidPluginName,
  pluginDir,
  pluginStagingDir,
  pluginsRootDir,
} from "./paths";
import { defaultNameFor, fetchPluginSource, parsePluginSource } from "./source";
import {
  readPluginRecords,
  updatePluginRecord,
  writePluginRecords,
  type PluginRecord,
  type PluginSource,
} from "./store";
import { diffTrees, hashTree, sha256, type TreeHashes } from "./tree-hash";

const logger = log.scope("plugins");

export class PluginInstallError extends Error {}

export interface PluginInstallPreview {
  stagingId: string;
  source: PluginSource;
  sha?: string;
  contents: PluginContents;
  /** Shown at the second confirm, in full. Empty = no second confirm. */
  runnables: string[];
  files: TreeHashes;
  /** Set for an update. */
  replaces: PluginRecord | null;
  changedFiles: string[];
  runnablesAdded: string[];
  runnablesRemoved: string[];
}

export async function preparePluginInstall(
  input: string,
  opts: { cwd?: string; fetchImpl?: typeof fetch; update?: string } = {},
): Promise<PluginInstallPreview> {
  const existing = opts.update
    ? readPluginRecords().find((r) => r.name === opts.update)
    : undefined;
  if (opts.update && !existing)
    throw new PluginInstallError(`${opts.update} is not installed`);
  // An update re-fetches the recorded source: a pinned commit stays put, a branch
  // or the default branch moves to its tip.
  const source = existing
    ? existing.source
    : parsePluginSource(input, opts.cwd);

  const stagingId = randomBytes(8).toString("hex");
  const stageRoot = path.join(pluginStagingDir(), stagingId);
  const pkg = path.join(stageRoot, "pkg");
  fs.mkdirSync(stageRoot, { recursive: true });
  try {
    const { sha } = await fetchPluginSource(source, pkg, opts.fetchImpl);
    const contents = readPluginContents(pkg, defaultNameFor(source));
    const files = hashTree(pkg);

    const installed = readPluginRecords().find((r) => r.name === contents.name);
    if (existing && contents.name !== existing.name) {
      throw new PluginInstallError(
        `The update names itself "${contents.name}", not "${existing.name}"`,
      );
    }
    if (!existing && installed) {
      throw new PluginInstallError(
        `${contents.name} is already installed; update it instead`,
      );
    }

    const runnables = describeRunnables(contents);
    const before = existing ? runnablesOfInstalled(existing) : [];
    return {
      stagingId,
      source,
      sha,
      contents,
      runnables,
      files,
      replaces: existing ?? null,
      changedFiles: existing ? diffTrees(existing.files, files) : [],
      runnablesAdded: runnables.filter((r) => !before.includes(r)),
      runnablesRemoved: before.filter((r) => !runnables.includes(r)),
    };
  } catch (err) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    if (err instanceof PluginManifestError)
      throw new PluginInstallError(err.message);
    throw err;
  }
}

function runnablesOfInstalled(record: PluginRecord): string[] {
  try {
    return describeRunnables(
      readPluginContents(pluginDir(record.name), record.name),
    );
  } catch {
    return [];
  }
}

export function commitPluginInstall(
  preview: PluginInstallPreview,
  opts: { runnablesConfirmed: boolean; folders?: string[] | null },
): PluginRecord {
  const stageRoot = path.join(pluginStagingDir(), preview.stagingId);
  const pkg = path.join(stageRoot, "pkg");
  if (!/^[0-9a-f]{16}$/.test(preview.stagingId) || !fs.existsSync(pkg)) {
    throw new PluginInstallError(
      "That install is no longer staged; start again",
    );
  }
  if (preview.runnables.length > 0 && !opts.runnablesConfirmed) {
    throw new PluginInstallError(
      "This silk runs code; confirm what it runs first",
    );
  }
  const name = preview.contents.name;
  if (!isValidPluginName(name))
    throw new PluginInstallError(`"${name}" is not a usable silk name`);

  // What lands must be what was shown.
  const changed = diffTrees(preview.files, hashTree(pkg));
  if (changed.length > 0) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw new PluginInstallError(
      `The staged files changed after the preview (${changed[0]}); start again`,
    );
  }

  const dest = pluginDir(name);
  const old = path.join(stageRoot, "old");
  if (fs.existsSync(dest)) {
    if (!preview.replaces)
      throw new PluginInstallError(`${name} is already installed`);
    fs.renameSync(dest, old);
  }
  fs.mkdirSync(pluginsRootDir(), { recursive: true });
  fs.renameSync(pkg, dest);
  fs.rmSync(stageRoot, { recursive: true, force: true });

  const record: PluginRecord = {
    name,
    format: preview.contents.format,
    version: preview.contents.version,
    source: preview.source,
    sha: preview.sha,
    installedAt: new Date().toISOString(),
    files: preview.files,
    runnablesDigest: runnablesDigest(preview.runnables),
    approvedHooks: preview.contents.hooks.map((h) => sha256(h.command)),
    enabled: preview.replaces?.enabled ?? true,
    folders:
      opts.folders !== undefined
        ? normalizeFolders(opts.folders)
        : (preview.replaces?.folders ?? null),
    model: preview.replaces?.model,
  };
  const records = readPluginRecords().filter((r) => r.name !== name);
  writePluginRecords([...records, record]);
  logger.info(
    `plugin ${preview.replaces ? "updated" : "installed"}: ${name} (${preview.sha ?? "local"})`,
  );
  return record;
}

export function discardPluginInstall(
  preview: Pick<PluginInstallPreview, "stagingId">,
): void {
  if (!/^[0-9a-f]{16}$/.test(preview.stagingId)) return;
  fs.rmSync(path.join(pluginStagingDir(), preview.stagingId), {
    recursive: true,
    force: true,
  });
}

/**
 * `/plugins review <name>`: the runnables of an installed plugin whose files are
 * unchanged but whose runnables no longer match what was approved (this version of
 * Atlarix reads more of it than the one that installed it). The surface shows
 * these in full; `approvePluginRunnables` records the OK.
 */
export function reviewPluginRunnables(name: string): string[] {
  const record = readPluginRecords().find((r) => r.name === name);
  if (!record) throw new PluginInstallError(`${name} is not installed`);
  const files = verifyPluginFiles(record);
  if (files) throw new PluginInstallError(files);
  return describeRunnables(readPluginContents(pluginDir(name), name));
}

export function approvePluginRunnables(
  name: string,
  shown: string[],
): PluginRecord {
  const now = reviewPluginRunnables(name);
  if (runnablesDigest(now) !== runnablesDigest(shown)) {
    throw new PluginInstallError(
      `${name} changed while you were reviewing it; review it again`,
    );
  }
  const contents = readPluginContents(pluginDir(name), name);
  const next = updatePluginRecord(name, (r) => ({
    ...r,
    runnablesDigest: runnablesDigest(now),
    approvedHooks: contents.hooks.map((h) => sha256(h.command)),
  }));
  if (!next) throw new PluginInstallError(`${name} is not installed`);
  return next;
}

export function removePlugin(name: string): boolean {
  if (!isValidPluginName(name)) return false;
  const removed =
    updatePluginRecord(name, () => null) !== null ||
    fs.existsSync(pluginDir(name));
  fs.rmSync(pluginDir(name), { recursive: true, force: true });
  return removed;
}

export function setPluginEnabled(
  name: string,
  enabled: boolean,
): PluginRecord | null {
  return updatePluginRecord(name, (r) => ({ ...r, enabled }));
}

export function setPluginFolders(
  name: string,
  folders: string[] | null,
): PluginRecord | null {
  return updatePluginRecord(name, (r) => ({
    ...r,
    folders: normalizeFolders(folders),
  }));
}

/**
 * Absolute, resolved, de-duplicated; a blank entry is dropped, and a list left
 * empty means "every folder" (null) — never a scope that matches every path by
 * accident (`""`) or none because of a trailing slash.
 */
function normalizeFolders(folders: string[] | null): string[] | null {
  if (!folders) return null;
  const clean = [
    ...new Set(
      folders.filter((f) => f.trim()).map((f) => path.resolve(f.trim())),
    ),
  ];
  return clean.length ? clean : null;
}

export function setPluginModel(
  name: string,
  model: string | undefined,
): PluginRecord | null {
  return updatePluginRecord(name, (r) => ({
    ...r,
    model: model?.trim() || undefined,
  }));
}

/** Staging folders left by a crash or an abandoned preview. */
export function sweepPluginStaging(maxAgeMs = 24 * 60 * 60 * 1000): void {
  const dir = pluginStagingDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const p = path.join(dir, entry.name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs)
        fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // gone already
    }
  }
}
