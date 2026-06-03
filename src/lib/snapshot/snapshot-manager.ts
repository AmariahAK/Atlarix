/**
 * Workspace-owned snapshots under `.atlarix/snapshots/<turnId>/` for code revert.
 *
 * Snapshot eligibility is enforced by callers (e.g. PermissionInterceptor): `captureSnapshot` only
 * needs `workspacePath` and `turnId`. If no turn id is set for the chat turn (ephemeral Ask), no
 * snapshot directory is written; Build streams typically pass a turn id so pre-write capture runs.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { atlasDir } from "./workspace-hash";
import { sanitizeLedgerDirSegment } from "@/lib/tasks/task-ledger";

const SNAPSHOTS_SUBDIR = "snapshots";
const MANIFEST = "manifest.json";
const FILES_DIR = "files";

export interface SnapshotManifest {
    /** Logical turn id (e.g. `plan:7`, SQLite message id); used for UI and ledger correlation. */
    turnId: string;
    /** Directory segment under `snapshots/`; equals `sanitizeLedgerDirSegment(turnId)` when set. */
    diskDirName?: string;
    timestamp: string;
    prompt?: string;
    filesChanged: string[];
}

function encodeRelToBak(rel: string): string {
    return rel.split(/[/\\]/).filter(Boolean).join("__") + ".bak";
}

function decodeBakToRel(bakName: string): string {
    const base = bakName.replace(/\.bak$/i, "");
    return base.split("__").join("/");
}

async function ensureDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
}

export interface CaptureSnapshotParams {
    workspacePath: string;
    turnId: string;
    relativePaths: string[];
    promptSummary?: string;
}

/**
 * Before approved writes: copy current file bytes to `.atlarix/snapshots/<turnId>/files/*.bak`
 * and update manifest. Idempotent per path (overwrites .bak with latest pre-write state).
 */
export async function captureSnapshot(params: CaptureSnapshotParams): Promise<void> {
    const { workspacePath, turnId } = params;
    if (!workspacePath || !turnId) return;

    const diskSeg = sanitizeLedgerDirSegment(turnId);
    const root = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR, diskSeg);
    const filesDir = path.join(root, FILES_DIR);
    await ensureDir(filesDir);

    const manifestPath = path.join(root, MANIFEST);
    let manifest: SnapshotManifest;
    try {
        const raw = await fs.readFile(manifestPath, "utf8");
        manifest = JSON.parse(raw) as SnapshotManifest;
    } catch {
        manifest = {
            turnId,
            diskDirName: diskSeg,
            timestamp: new Date().toISOString(),
            prompt: params.promptSummary,
            filesChanged: [],
        };
    }
    manifest.turnId = turnId;
    manifest.diskDirName = diskSeg;
    if (params.promptSummary) manifest.prompt = params.promptSummary;

    const normalized = params.relativePaths.map((p) => p.split(path.sep).join("/")).filter(Boolean);
    for (const rel of normalized) {
        const abs = path.join(workspacePath, rel);
        const bakName = encodeRelToBak(rel);
        const bakPath = path.join(filesDir, bakName);
        try {
            const buf = await fs.readFile(abs);
            await fs.writeFile(bakPath, buf);
        } catch {
            try {
                await fs.writeFile(bakPath, "", "utf8");
            } catch {
                // ignore
            }
        }
        if (!manifest.filesChanged.includes(rel)) manifest.filesChanged.push(rel);
    }
    manifest.timestamp = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

export interface RevertSnapshotResult {
    success: boolean;
    error?: string;
    restoredFiles?: number;
}

/**
 * Restore all files from `.atlarix/snapshots/<turnId>/files/*.bak`.
 */
export async function revertSnapshot(params: {
    workspacePath: string;
    turnId: string;
}): Promise<RevertSnapshotResult> {
    const { workspacePath, turnId } = params;
    const diskSeg = sanitizeLedgerDirSegment(turnId);
    const root = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR, diskSeg);

    const filesDir = path.join(root, FILES_DIR);
    let restored = 0;
    try {
        const names = await fs.readdir(filesDir).catch(() => [] as string[]);
        for (const name of names) {
            if (!name.endsWith(".bak")) continue;
            const rel = decodeBakToRel(name);
            const abs = path.join(workspacePath, rel);
            const bakPath = path.join(filesDir, name);
            try {
                const buf = await fs.readFile(bakPath);
                await ensureDir(path.dirname(abs));
                await fs.writeFile(abs, buf);
                restored++;
            } catch {
                // skip
            }
        }
    } catch {
        // no files dir for this turn
    }

    return { success: true, restoredFiles: restored };
}

/**
 * Restore only specific workspace-relative paths from `.atlarix/snapshots/<turnId>/files/*.bak`.
 */
export async function revertSnapshotFiles(params: {
    workspacePath: string;
    turnId: string;
    relativePaths: string[];
}): Promise<RevertSnapshotResult> {
    const { workspacePath, turnId, relativePaths } = params;
    if (relativePaths.length === 0) {
        return { success: true, restoredFiles: 0 };
    }
    const diskSeg = sanitizeLedgerDirSegment(turnId);
    const root = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR, diskSeg);
    const filesDir = path.join(root, FILES_DIR);
    let restored = 0;
    const normalized = relativePaths.map((p) => p.split(path.sep).join("/")).filter(Boolean);
    for (const rel of normalized) {
        const bakName = encodeRelToBak(rel);
        const bakPath = path.join(filesDir, bakName);
        const abs = path.join(workspacePath, rel);
        try {
            const buf = await fs.readFile(bakPath);
            await ensureDir(path.dirname(abs));
            await fs.writeFile(abs, buf);
            restored++;
        } catch {
            // no .bak for this path in this turn
        }
    }
    return { success: true, restoredFiles: restored };
}
