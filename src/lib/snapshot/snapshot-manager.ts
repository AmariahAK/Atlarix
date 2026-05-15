/**
 * Workspace-owned snapshots under `.atlarix/snapshots/<turnId>/` for code + diagram revert.
 *
 * Snapshot eligibility is enforced by callers (e.g. PermissionInterceptor): `captureSnapshot` only
 * needs `workspacePath` and `turnId`. If no turn id is set for the chat turn (ephemeral Ask), no
 * snapshot directory is written; Build streams typically pass a turn id so pre-write capture runs.
 *
 * Diagram history for revert lives in `diagram.md` per turn (legacy manifests may still carry
 * `diagramBefore` JSON — `revertSnapshot` reads `diagram.md` first, then falls back).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { db } from "@/db";
import { diagrams } from "@/db/schema";
import { eq } from "drizzle-orm";
import { atlasDir, computeWorkspaceFileHashes } from "./workspace-hash";
import { writeSnapshotHashesToWorkspace } from "./staleness";
import { sanitizeLedgerDirSegment } from "@/lib/tasks/task-ledger";

const SNAPSHOTS_SUBDIR = "snapshots";
const MANIFEST = "manifest.json";
const FILES_DIR = "files";
const DIAGRAM_MD = "diagram.md";

export interface SnapshotManifest {
    /** Logical turn id (e.g. `plan:7`, SQLite message id); used for UI and ledger correlation. */
    turnId: string;
    /** Directory segment under `snapshots/`; equals `sanitizeLedgerDirSegment(turnId)` when set. */
    diskDirName?: string;
    timestamp: string;
    prompt?: string;
    /** @deprecated Prefer `diagram.md` in the same directory; still read for old snapshots */
    diagramBefore?: string;
    filesChanged: string[];
}

/** Parse mermaid body from markdown fence or treat whole file as mermaid when it looks like a diagram. */
export function extractMermaidFromMarkdown(md: string): string | undefined {
    const fence = /```\s*mermaid\s*([\s\S]*?)```/i.exec(md);
    if (fence) return fence[1].trim();
    const t = md.trim();
    if (
        /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt)\b/m.test(
            t,
        )
    ) {
        return t;
    }
    return undefined;
}

/** Rich `diagram.md` template; `extractMermaidFromMarkdown` still finds the fenced block. */
export function buildRichDiagramMarkdown(fields: {
    mermaidBody: string;
    capturedAt?: string;
    promptLine?: string;
    blueprintSummary?: string;
}): string {
    const cap = fields.capturedAt ?? new Date().toISOString();
    const inner = fields.mermaidBody.trim();
    const summary =
        fields.blueprintSummary?.trim() ||
        "(Blueprint summary not attached to this snapshot.)";
    return `# Workspace architecture

**Captured:** ${cap}
${fields.promptLine ? `**Context:** ${fields.promptLine}\n` : ""}
## Blueprint

${summary}

## Mermaid

\`\`\`mermaid
${inner}
\`\`\`
`;
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

async function readPreviousDiagramContentFromSnapshot(
    root: string,
    manifest: SnapshotManifest,
): Promise<string | undefined> {
    const mdPath = path.join(root, DIAGRAM_MD);
    try {
        const raw = await fs.readFile(mdPath, "utf8");
        const extracted = extractMermaidFromMarkdown(raw);
        if (extracted) return extracted;
        const t = raw.trim();
        if (t) return t;
    } catch {
        // use legacy manifest field
    }
    return manifest.diagramBefore;
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
 * Pre-write diagram text is stored in `diagram.md` (not new `diagramBefore` in manifest).
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
    if (params.diagramBefore !== undefined) {
        await fs.writeFile(path.join(root, DIAGRAM_MD), params.diagramBefore, "utf8");
        delete manifest.diagramBefore;
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

export interface DiagramSnapshotTimelineEntry {
    turnId: string;
    timestamp: string;
    prompt?: string;
    isInitial?: boolean;
}

/** List snapshot turns under `.atlarix/snapshots/` (newest first). */
export async function listDiagramSnapshotTimeline(
    workspacePath: string,
): Promise<DiagramSnapshotTimelineEntry[]> {
    const base = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR);
    let names: string[] = [];
    try {
        names = await fs.readdir(base);
    } catch {
        return [];
    }
    const out: DiagramSnapshotTimelineEntry[] = [];
    for (const diskFolderName of names) {
        if (diskFolderName.startsWith(".") || !diskFolderName.trim()) continue;
        const dir = path.join(base, diskFolderName);
        const manifestPath = path.join(dir, MANIFEST);
        const diagramPath = path.join(dir, DIAGRAM_MD);
        let ts = "";
        let prompt: string | undefined;
        let logicalTurnId = diskFolderName;
        try {
            const raw = await fs.readFile(manifestPath, "utf8");
            const m = JSON.parse(raw) as SnapshotManifest;
            ts = m.timestamp || "";
            prompt = m.prompt;
            logicalTurnId = m.turnId?.trim() ? m.turnId : diskFolderName;
        } catch {
            try {
                const st = await fs.stat(diagramPath);
                ts = st.mtime.toISOString();
            } catch {
                continue;
            }
        }
        if (!ts) {
            try {
                const st = await fs.stat(diagramPath);
                ts = st.mtime.toISOString();
            } catch {
                ts = new Date(0).toISOString();
            }
        }
        out.push({
            turnId: logicalTurnId,
            timestamp: ts,
            prompt,
            isInitial: logicalTurnId === "initial" || diskFolderName === "initial",
        });
    }
    out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return out;
}

/**
 * First-time baseline diagram under `.atlarix/snapshots/initial/diagram.md` (idempotent).
 */
export async function ensureInitialDiagramSnapshot(
    workspacePath: string,
    diagramMermaid: string,
): Promise<void> {
    if (!diagramMermaid.trim()) return;
    const initialRoot = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR, "initial");
    const diagramPath = path.join(initialRoot, DIAGRAM_MD);
    try {
        await fs.access(diagramPath);
        return;
    } catch {
        // create
    }
    await ensureDir(initialRoot);
    const body = extractMermaidFromMarkdown(diagramMermaid) ?? diagramMermaid.trim();
    await fs.writeFile(
        diagramPath,
        buildRichDiagramMarkdown({
            mermaidBody: body,
            promptLine: "Initial workspace diagram baseline",
        }),
        "utf8",
    );
}

export interface RevertSnapshotResult {
    success: boolean;
    error?: string;
    restoredFiles?: number;
}

/**
 * Restore files + diagram from `.atlarix/snapshots/<turnId>/` (diagram from `diagram.md` or legacy manifest).
 */
export async function revertSnapshot(params: {
    workspacePath: string;
    turnId: string;
    workspaceId: number;
}): Promise<RevertSnapshotResult> {
    const { workspacePath, turnId, workspaceId } = params;
    const diskSeg = sanitizeLedgerDirSegment(turnId);
    const root = path.join(atlasDir(workspacePath), SNAPSHOTS_SUBDIR, diskSeg);
    const manifestPath = path.join(root, MANIFEST);
    let manifest: SnapshotManifest | null = null;
    try {
        const raw = await fs.readFile(manifestPath, "utf8");
        manifest = JSON.parse(raw) as SnapshotManifest;
    } catch {
        manifest = null;
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

    if (diagramRow) {
        const previousDiagram =
            manifest != null
                ? await readPreviousDiagramContentFromSnapshot(root, manifest)
                : await readPreviousDiagramContentFromSnapshot(root, {
                      turnId,
                      timestamp: "",
                      filesChanged: [],
                  });
        if (previousDiagram !== undefined) {
            await db
                .update(diagrams)
                .set({
                    content: previousDiagram,
                    updatedAt: new Date(),
                })
                .where(eq(diagrams.id, diagramRow.id));
        }
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

    // Pass 7: Blueprint broadcast removed with the Blueprint subsystem.
    void workspaceId;

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
    /** When set, persist diagram snapshot hashes and broadcast blueprint (matches full revert UX for disk). */
    workspaceId?: number;
}): Promise<RevertSnapshotResult> {
    const { workspacePath, turnId, relativePaths, workspaceId } = params;
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
    try {
        const hashes = await computeWorkspaceFileHashes(workspacePath);
        await writeSnapshotHashesToWorkspace(workspacePath, hashes);
        if (workspaceId != null) {
            const [diagramRow] = await db
                .select()
                .from(diagrams)
                .where(eq(diagrams.workspaceId, workspaceId))
                .limit(1);
            if (diagramRow) {
                await persistDiagramLastSnapshotHashes(diagramRow.id, hashes);
            }
        }
    } catch {
        // non-fatal
    }
    // Pass 7: Blueprint broadcast removed with the Blueprint subsystem.
    return { success: true, restoredFiles: restored };
}
