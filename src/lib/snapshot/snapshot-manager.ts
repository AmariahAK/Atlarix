/**
 * Workspace-owned snapshots under `.atlarix/snapshots/<turnId>/` for code + diagram revert.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { db } from "@/db";
import { diagrams, diagramVersions } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { atlasDir, computeWorkspaceFileHashes } from "./workspace-hash";
import { writeSnapshotHashesToWorkspace } from "./staleness";

const SNAPSHOTS_SUBDIR = "snapshots";
const MANIFEST = "manifest.json";
const FILES_DIR = "files";

export interface SnapshotManifest {
    turnId: string;
    timestamp: string;
    prompt?: string;
    diagramBefore?: string;
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

/** Compute workspace file hashes, write `.atlarix/snapshots/snapshot_hashes.json`, and persist on the diagram row. */
export async function persistWorkspaceSnapshotHashes(diagramId: number, workspacePath: string): Promise<void> {
    const hashes = await computeWorkspaceFileHashes(workspacePath);
    await writeSnapshotHashesToWorkspace(workspacePath, hashes);
    await persistDiagramLastSnapshotHashes(diagramId, hashes);
}

export async function persistDiagramLastSnapshotHashes(
    diagramId: number,
    hashes: Record<string, string>,
): Promise<void> {
    await db
        .update(diagrams)
        .set({ lastSnapshotHashes: hashes, updatedAt: new Date() })
        .where(eq(diagrams.id, diagramId));
}

const VERSION_CAP = 20;

export async function insertDiagramVersionWithCap(values: {
    diagramId: number;
    content: string;
    changeDescription?: string | null;
    trigger?: "user_request" | "auto_sync" | "template_clone" | "file_change";
    summary?: string | null;
    chatTurnId?: string | null;
}): Promise<void> {
    await db.insert(diagramVersions).values({
        diagramId: values.diagramId,
        content: values.content,
        changeDescription: values.changeDescription ?? null,
        trigger: values.trigger,
        summary: values.summary ?? null,
        chatTurnId: values.chatTurnId ?? null,
    });
    const rows = await db
        .select({ id: diagramVersions.id })
        .from(diagramVersions)
        .where(eq(diagramVersions.diagramId, values.diagramId))
        .orderBy(asc(diagramVersions.createdAt));
    if (rows.length > VERSION_CAP) {
        const toRemove = rows.slice(0, rows.length - VERSION_CAP);
        for (const r of toRemove) {
            await db.delete(diagramVersions).where(eq(diagramVersions.id, r.id));
        }
    }
}

export interface CaptureSnapshotParams {
    workspacePath: string;
    turnId: string;
    relativePaths: string[];
    diagramBefore?: string;
    promptSummary?: string;
}

/**
 * Before approved writes: copy current file bytes to `.atlarix/snapshots/<turnId>/files/*.bak`
 * and update manifest. Idempotent per path (overwrites .bak with latest pre-write state).
 */
export async function captureSnapshot(params: CaptureSnapshotParams): Promise<void> {
    const { workspacePath, turnId } = params;
    if (!workspacePath || !turnId) return;

    const root = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR, turnId);
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
            timestamp: new Date().toISOString(),
            prompt: params.promptSummary,
            diagramBefore: params.diagramBefore,
            filesChanged: [],
        };
    }
    if (params.diagramBefore !== undefined && manifest.diagramBefore === undefined) {
        manifest.diagramBefore = params.diagramBefore;
    }
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
 * Restore files + diagram from `.atlarix/snapshots/<turnId>/`; insert "Before revert" diagram version.
 */
export async function revertSnapshot(params: {
    workspacePath: string;
    turnId: string;
    workspaceId: number;
}): Promise<RevertSnapshotResult> {
    const { workspacePath, turnId, workspaceId } = params;
    const root = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR, turnId);
    const manifestPath = path.join(root, MANIFEST);
    let manifest: SnapshotManifest;
    try {
        const raw = await fs.readFile(manifestPath, "utf8");
        manifest = JSON.parse(raw) as SnapshotManifest;
    } catch (e) {
        return {
            success: false,
            error: e instanceof Error ? e.message : "Manifest not found for this turn",
        };
    }

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
        // continue to diagram
    }

    const [diagramRow] = await db
        .select()
        .from(diagrams)
        .where(eq(diagrams.workspaceId, workspaceId))
        .limit(1);

    if (diagramRow && manifest.diagramBefore !== undefined) {
        await insertDiagramVersionWithCap({
            diagramId: diagramRow.id,
            content: diagramRow.content,
            changeDescription: `Before revert (turn ${turnId})`,
            trigger: "user_request",
            chatTurnId: turnId,
        });
        await db
            .update(diagrams)
            .set({
                content: manifest.diagramBefore,
                updatedAt: new Date(),
            })
            .where(eq(diagrams.id, diagramRow.id));
    }

    try {
        const hashes = await computeWorkspaceFileHashes(workspacePath);
        await writeSnapshotHashesToWorkspace(workspacePath, hashes);
        if (diagramRow) {
            await persistDiagramLastSnapshotHashes(diagramRow.id, hashes);
        }
    } catch {
        // non-fatal
    }

    return { success: true, restoredFiles: restored };
}

/**
 * Restore only specific workspace-relative paths from `.atlarix/snapshots/<turnId>/files/*.bak`.
 * Does not change diagram (use full `revertSnapshot` for diagram + all files).
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
    const root = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR, turnId);
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
    try {
        const hashes = await computeWorkspaceFileHashes(workspacePath);
        await writeSnapshotHashesToWorkspace(workspacePath, hashes);
    } catch {
        // non-fatal
    }
    return { success: true, restoredFiles: restored };
}
