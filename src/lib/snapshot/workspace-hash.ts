/**
 * Walk workspace and compute MD5 per file (relative posix path → hex hash).
 * Mirrors legacy diagram internal-git ignore rules.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";

export function atlasDir(workspacePath: string): string {
    return path.join(workspacePath, ".atlarix");
}

const IGNORE_NAMES_LOWER = new Set([
    "node_modules", ".git", "dist", "build", ".next", ".nuxt", "coverage",
    ".cache", "__pycache__", ".vite", ".env", ".env.local",
    "userdata",
    ".cursor",
]);

function isIgnoredEntryName(name: string): boolean {
    if (IGNORE_NAMES_LOWER.has(name.toLowerCase())) return true;
    if (name.startsWith(".") && name !== ".env") return true;
    return false;
}

export function shouldIgnoreRelativePath(relPath: string): boolean {
    return relPath.split(/[/\\]/).some((s) => s.toLowerCase() === "userdata")
        || relPath.split(/[/\\]/).some((s) => IGNORE_NAMES_LOWER.has(s.toLowerCase()));
}

export async function computeWorkspaceFileHashes(workspaceRoot: string, maxDepth = 12): Promise<Record<string, string>> {
    const out: Record<string, string> = {};

    const walk = async (dir: string, relDir: string, depth: number): Promise<void> => {
        if (depth > maxDepth) return;
        let entries: fsSync.Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (isIgnoredEntryName(e.name)) continue;
            const fullPath = path.join(dir, e.name);
            const relPath = relDir ? `${relDir}/${e.name}` : e.name;
            const posixRel = relPath.split(path.sep).join("/");
            if (shouldIgnoreRelativePath(posixRel)) continue;
            if (e.isDirectory()) {
                await walk(fullPath, relPath, depth + 1);
            } else {
                try {
                    const buf = await fs.readFile(fullPath);
                    const hash = crypto.createHash("md5").update(buf).digest("hex");
                    out[posixRel] = hash;
                } catch {
                    // unreadable skip
                }
            }
        }
    };

    await walk(workspaceRoot, "", 0);
    return out;
}
