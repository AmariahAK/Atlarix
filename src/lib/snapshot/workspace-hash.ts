/**
 * Walk workspace and compute MD5 per file (relative posix path → hex hash).
 * Mirrors legacy diagram internal-git ignore rules.
 */

import * as path from "path";

export function atlasDir(workspacePath: string): string {
    return path.join(workspacePath, ".atlarix");
}

const IGNORE_NAMES_LOWER = new Set([
    "node_modules", ".git", "dist", "build", ".next", ".nuxt", "coverage",
    ".cache", "__pycache__", ".vite", ".env", ".env.local",
    "userdata",
    ".cursor",
]);


export function shouldIgnoreRelativePath(relPath: string): boolean {
    return relPath.split(/[/\\]/).some((s) => s.toLowerCase() === "userdata")
        || relPath.split(/[/\\]/).some((s) => IGNORE_NAMES_LOWER.has(s.toLowerCase()));
}

