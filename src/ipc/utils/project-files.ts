/**
 * Project Files Discovery
 * ========================
 * Single source of truth for workspace file discovery.
 *
 * Uses a 4-strategy cascade:
 * 1. git ls-files (primary) — uses project's own .gitignore
 * 2. fd (fallback) — cross-platform, respects .gitignore
 * 3. ripgrep --files (fallback) — also respects .gitignore
 * 4. getFilesRecursively (last resort) — legacy with manual exclusions
 *
 * Results are cached in memory for 5 minutes per workspace.
 * File discovery is LAZY — only runs when a tool or handler
 * explicitly needs the file list. Never runs on workspace open.
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import log from "electron-log";
import { getFilesRecursively } from "./file_utils";
import {
    projectFilesCacheKey,
    normalizeProjectFilesScopePath,
    getCachedWorkspaceDiscovery,
    clearWorkspaceDiscoverySessionCache,
} from "./workspace-discovery";
import { ensureSymbolIndex, getSymbolsForFile } from "@/lib/index/ctags-index";
import { structureFromSymbols } from "@/lib/index/structure-from-symbols";

const execAsync = promisify(exec);
const logger = log.scope("project-files");

const CDK_ASSET_HEX_SEGMENT = /^[0-9a-f]{64}$/;

export function isExcludedDiscoveryRelPath(rel: string): boolean {
    const norm = rel.replace(/\\/g, "/");
    for (const seg of norm.split("/")) {
        if (!seg) continue;
        if (
            seg === ".cdk-out-deploy" ||
            seg === "cdk.out" ||
            seg === ".cdk-staging" ||
            seg === ".aws-sam"
        ) {
            return true;
        }
        if (CDK_ASSET_HEX_SEGMENT.test(seg)) return true;
    }
    return false;
}

function filterDiscoveryPaths(files: string[]): string[] {
    return files.filter((f) => !isExcludedDiscoveryRelPath(f));
}

/**
 * Normalize a path emitted by `fd` / `rg --files` to a workspace-relative posix path.
 *
 * - When the tool returns a relative path (the common case when run with `cwd`),
 *   `path.relative(cwd, "src/app.ts")` would resolve `src/app.ts` against
 *   process.cwd() rather than the workspace, producing absolute or cross-drive
 *   garbage on Windows runners. So treat already-relative paths as relative
 *   to the workspace.
 * - When the tool returns an absolute path, compute the workspace-relative form.
 */
function normalizeDiscoveredFile(
    workspacePath: string,
    raw: string,
): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const stripped = trimmed.replace(/^\.[\\/]+/, "");
    let rel: string;
    if (path.isAbsolute(stripped)) {
        rel = path.relative(workspacePath, stripped);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    } else {
        rel = stripped;
    }
    return rel.replace(/\\/g, "/");
}

export interface ProjectFilesResult {
    files: string[];
    strategy: "git" | "fd" | "ripgrep" | "fallback";
    count: number;
    /** Paths the app could not read (permissions); mainly from fallback walk */
    accessWarnings?: string[];
}

interface FileListCacheEntry {
    result: ProjectFilesResult;
    timestamp: number;
}

const fileListCache = new Map<string, FileListCacheEntry>();
const FILE_LIST_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface StructureResult {
    imports: string[];
    exports: string[];
    functions: string[];
    classes: string[];
    types?: string[];
    constants?: string[];
}

interface StructureScanCacheEntry {
    result: Record<string, StructureResult>;
    timestamp: number;
}

const structureScanCache = new Map<string, StructureScanCacheEntry>();
const STRUCTURE_SCAN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function findGitRoot(start: string): string | null {
    let dir = path.resolve(start);
    const root = path.parse(dir).root;
    while (true) {
        try {
            if (fs.existsSync(path.join(dir, ".git"))) return dir;
        } catch {
            /* ignore */
        }
        const parent = path.dirname(dir);
        if (parent === dir || dir === root) break;
        dir = parent;
    }
    return null;
}

type GitListContext = {
    gitCwd: string;
    /** Pathspec for `git ls-files -- <pathspec>` when listing a subtree from repo root. */
    pathspec?: string;
    /** Strip this prefix from paths so results are relative to the requested scan root. */
    stripPrefix?: string;
};

function resolveGitListContext(workspacePath: string, scopePath?: string): GitListContext {
    const resolved = path.resolve(workspacePath);
    const scope = normalizeProjectFilesScopePath(scopePath);

    if (scope) {
        const scopedDir = path.join(resolved, scope);
        if (fs.existsSync(path.join(scopedDir, ".git"))) {
            return { gitCwd: scopedDir };
        }
        return { gitCwd: resolved, pathspec: `${scope}/`, stripPrefix: `${scope}/` };
    }

    const gitRoot = findGitRoot(resolved);
    if (gitRoot && path.normalize(gitRoot) !== path.normalize(resolved)) {
        const rel = path.relative(gitRoot, resolved).replace(/\\/g, "/");
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
            const prefix = rel.endsWith("/") ? rel : `${rel}/`;
            return { gitCwd: gitRoot, pathspec: prefix, stripPrefix: prefix };
        }
    }

    return { gitCwd: resolved };
}

function pathsRelativeToScanRoot(files: string[], ctx: GitListContext): string[] {
    if (!ctx.stripPrefix) return files;
    const p = ctx.stripPrefix;
    return files
        .map((f) => {
            const n = f.replace(/\\/g, "/");
            if (n.startsWith(p)) return n.slice(p.length);
            return n;
        })
        .filter(Boolean);
}

const ALWAYS_EXCLUDE = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".cache",
    "coverage",
    "cdk.out",
    ".cdk-out-deploy",
    ".cdk-staging",
    ".aws-sam",
    "__pycache__",
    ".venv",
    "venv",
    "venv-ci",
    "venv-dev",
    "venv-test",
    "site-packages",
    "dist-packages",
    "tzdata",
    "zoneinfo",
    "target",
    "vendor",
    ".turbo",
    ".nx",
    ".nyc_output",
];

/**
 * Get all project files using the best available strategy.
 * Results are cached for 5 minutes per workspace.
 *
 * @param workspacePath - Absolute path to workspace or section scan root
 * @param options - Optional extension filter, scopePath (workspace-relative), timeout
 */
export async function getProjectFiles(
    workspacePath: string,
    options?: {
        timeout?: number;
        extensions?: string[];
        /** Workspace-relative folder (e.g. spacinsider-cli). Omit when workspacePath is already the scan root. */
        scopePath?: string;
    }
): Promise<ProjectFilesResult> {
    const scope = normalizeProjectFilesScopePath(options?.scopePath);
    const cacheKey = projectFilesCacheKey(workspacePath, scope);
    const cached = fileListCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < FILE_LIST_TTL_MS) {
        logger.info(
            `[project-files] cache hit — ${cached.result.count} files via ${cached.result.strategy}${scope ? ` scope=${scope}` : ""}`
        );
        return cached.result;
    }

    const timeout = options?.timeout ?? 15_000;
    const gitCtx = resolveGitListContext(workspacePath, scope);

    // -----------------------------------------------
    // STRATEGY 1: git ls-files (primary)
    // -----------------------------------------------
    try {
        const args = ["ls-files"];

        if (options?.extensions?.length) {
            for (const ext of options.extensions) {
                args.push(`*.${ext}`);
            }
        }

        if (gitCtx.pathspec) {
            args.push("--", gitCtx.pathspec);
        }

        const { stdout } = await execAsync("git " + args.join(" "), {
            cwd: gitCtx.gitCwd,
            timeout,
            maxBuffer: 50 * 1024 * 1024,
        });

        const files = filterDiscoveryPaths(
            pathsRelativeToScanRoot(
                stdout
                    .split("\n")
                    .filter(Boolean)
                    .map((f) => f.replace(/\\/g, "/")),
                gitCtx,
            ),
        );

        if (files.length > 0) {
            const result: ProjectFilesResult = {
                files,
                strategy: "git",
                count: files.length,
            };
            fileListCache.set(cacheKey, {
                result,
                timestamp: Date.now(),
            });
            logger.info(
                `[project-files] ${files.length} files via git ls-files${scope ? ` scope=${scope}` : gitCtx.pathspec ? ` pathspec=${gitCtx.pathspec}` : ""}`
            );
            return result;
        }
    } catch (err) {
        logger.info(
            "[project-files] git ls-files not available or failed, trying fd",
            {
                error: err instanceof Error ? err.message : String(err),
            }
        );
    }

    // -----------------------------------------------
    // STRATEGY 1b: multi-repo parent — aggregate git ls-files from each nested repo
    // -----------------------------------------------
    const hints1b = getCachedWorkspaceDiscovery(workspacePath);
    if (hints1b.isMultiRepoWorkspace && hints1b.nestedRepoNames?.length) {
        logger.info(
            `[project-files] multi-repo: detected ${hints1b.nestedRepoNames.length} repos, trying git ls-files per subfolder`,
        );
        const merged: string[] = [];
        for (const name of hints1b.nestedRepoNames) {
            const subRoot = path.join(workspacePath, name);
            try {
                const args = ["ls-files"];
                if (options?.extensions?.length) {
                    for (const ext of options.extensions) {
                        args.push(`*.${ext}`);
                    }
                }
                const { stdout } = await execAsync("git " + args.join(" "), {
                    cwd: subRoot,
                    timeout,
                    maxBuffer: 50 * 1024 * 1024,
                });
                const rels = stdout
                    .split("\n")
                    .filter(Boolean)
                    .map((f) => f.replace(/\\/g, "/"));
                for (const r of rels) {
                    merged.push(`${name}/${r}`);
                }
            } catch {
                /* not a git worktree or git failed */
            }
        }
        const filesMulti = filterDiscoveryPaths(merged);
        if (filesMulti.length > 0) {
            const result: ProjectFilesResult = {
                files: filesMulti,
                strategy: "git",
                count: filesMulti.length,
            };
            fileListCache.set(cacheKey, {
                result,
                timestamp: Date.now(),
            });
            logger.info(
                `[project-files] ${filesMulti.length} files via git ls-files (multi-repo aggregate)`,
            );
            return result;
        }
    }

    // -----------------------------------------------
    // STRATEGY 2: fd (fallback)
    // -----------------------------------------------
    try {
        const args = [
            "--type", "f",
            "--hidden",
            "--no-ignore-vcs",
            "--follow",
            ".",
        ];

        if (options?.extensions?.length) {
            for (const ext of options.extensions) {
                args.push("--extension", ext);
            }
        }

        for (const dir of ALWAYS_EXCLUDE) {
            args.push("--exclude", dir);
        }

        const { stdout } = await execAsync("fd " + args.join(" "), {
            cwd: workspacePath,
            timeout,
            maxBuffer: 50 * 1024 * 1024,
        });

        // fd path output may be relative (default with `cwd`) or absolute (some flags).
        const files = filterDiscoveryPaths(
            stdout
                .split("\n")
                .map((f) => normalizeDiscoveredFile(workspacePath, f))
                .filter((f): f is string => f !== null),
        );

        if (files.length > 0) {
            const result: ProjectFilesResult = {
                files,
                strategy: "fd",
                count: files.length,
            };
            fileListCache.set(cacheKey, {
                result,
                timestamp: Date.now(),
            });
            logger.info(`[project-files] ${files.length} files via fd`);
            return result;
        }
    } catch (err) {
        logger.info(
            "[project-files] fd not available or failed, trying ripgrep",
            {
                error: err instanceof Error ? err.message : String(err),
            }
        );
    }

    // -----------------------------------------------
    // STRATEGY 3: ripgrep --files (fallback)
    // -----------------------------------------------
    try {
        const args = ["--files", "--hidden"];

        if (options?.extensions?.length) {
            const glob = `*.{${options.extensions.join(",")}}`;
            args.push("--glob", glob);
        }

        const { stdout } = await execAsync("rg " + args.join(" "), {
            cwd: workspacePath,
            timeout,
            maxBuffer: 50 * 1024 * 1024,
        });

        // `rg --files` emits paths relative to its cwd by default.
        const files = filterDiscoveryPaths(
            stdout
                .split("\n")
                .map((f) => normalizeDiscoveredFile(workspacePath, f))
                .filter((f): f is string => f !== null),
        );

        if (files.length > 0) {
            const result: ProjectFilesResult = {
                files,
                strategy: "ripgrep",
                count: files.length,
            };
            fileListCache.set(cacheKey, {
                result,
                timestamp: Date.now(),
            });
            logger.info(
                `[project-files] ${files.length} files via ripgrep --files`
            );
            return result;
        }
    } catch (err) {
        logger.info(
            "[project-files] ripgrep not available or failed, falling back to legacy scan",
            {
                error: err instanceof Error ? err.message : String(err),
            }
        );
    }

    // -----------------------------------------------
    // STRATEGY 4: getFilesRecursively (last resort)
    // -----------------------------------------------
    const discovery = getCachedWorkspaceDiscovery(workspacePath);
    if (discovery.isMultiRepoWorkspace && discovery.nestedRepoNames?.length) {
        logger.info(
            `[project-files] multi-repo: detected ${discovery.nestedRepoNames.length} repos, scanning subfolders only (legacy walk)`,
        );
    } else {
        logger.warn(
            "[project-files] all fast strategies failed — using legacy recursive scan. " +
                "Results may include build artifacts.",
        );
    }
    const accessWarnings: string[] = [];
    let legacyFiles: string[];
    if (discovery.isMultiRepoWorkspace && discovery.nestedRepoNames?.length) {
        legacyFiles = [];
        for (const name of discovery.nestedRepoNames) {
            const subRoot = path.join(workspacePath, name);
            const subFiles = getFilesRecursively(subRoot, subRoot, accessWarnings).map((f) =>
                f.replace(/\\/g, "/"),
            );
            for (const f of subFiles) {
                legacyFiles.push(`${name}/${f}`);
            }
        }
    } else {
        legacyFiles = getFilesRecursively(workspacePath, workspacePath, accessWarnings).map((f) =>
            f.replace(/\\/g, "/"),
        );
    }
    const filteredLegacy = filterDiscoveryPaths(legacyFiles);
    const result: ProjectFilesResult = {
        files: filteredLegacy,
        strategy: "fallback",
        count: filteredLegacy.length,
        ...(accessWarnings.length > 0 ? { accessWarnings } : {}),
    };
    fileListCache.set(cacheKey, {
        result,
        timestamp: Date.now(),
    });
    return result;
}

/**
 * Clear the file list cache for a workspace.
 * Call this when the workspace changes significantly.
 */
export function clearFileListCache(workspacePath?: string): void {
    if (workspacePath) {
        clearWorkspaceDiscoverySessionCache(workspacePath);
        const resolved = path.resolve(workspacePath);
        for (const key of [...fileListCache.keys()]) {
            if (key.startsWith(resolved)) fileListCache.delete(key);
        }
    } else {
        clearWorkspaceDiscoverySessionCache();
        fileListCache.clear();
    }
}

/**
 * Get structure scan for top entry point files.
 * Results are cached for 5 minutes per workspace.
 *
 * @param workspacePath - Absolute path to workspace root
 * @param entryPointFiles - Paths of entry point files to scan (relative or absolute)
 */
export async function getStructureScan(
    workspacePath: string,
    entryPointFiles: string[]
): Promise<Record<string, StructureResult>> {
    const cacheKey = workspacePath;
    const cached = structureScanCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < STRUCTURE_SCAN_TTL_MS) {
        logger.info(`[structure-scan] cache hit — ${Object.keys(cached.result).length} files`);
        return cached.result;
    }

    const results: Record<string, StructureResult> = {};

    let symbolIndex: Awaited<ReturnType<typeof ensureSymbolIndex>> | null = null;
    try {
        symbolIndex = await ensureSymbolIndex(workspacePath);
    } catch (err) {
        logger.warn("[structure-scan] ctags index unavailable:", err);
    }

    for (const filePath of entryPointFiles.slice(0, 20)) {
        const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(workspacePath, filePath);
        const relPath = path.relative(workspacePath, absPath).replace(/\\/g, "/");
        if (symbolIndex) {
            const symbols = getSymbolsForFile(symbolIndex, relPath);
            if (symbols.length > 0) {
                results[relPath] = structureFromSymbols(symbols);
                continue;
            }
        }
    }

    structureScanCache.set(cacheKey, {
        result: results,
        timestamp: Date.now(),
    });
    logger.info(`[structure-scan] scanned ${Object.keys(results).length} files`);

    return results;
}

/**
 * Clear the structure scan cache for a workspace.
 */
export function clearStructureScanCache(workspacePath?: string): void {
    if (workspacePath) {
        structureScanCache.delete(workspacePath);
    } else {
        structureScanCache.clear();
    }
}
