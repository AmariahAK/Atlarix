/**
 * Project Files Discovery
 * ========================
 * Single source of truth for workspace file discovery.
 *
 * Uses a 3-strategy cascade (on-demand only — never on workspace open):
 * 1. fd — cross-platform, respects .gitignore
 * 2. ripgrep --files — also respects .gitignore
 * 3. getFilesRecursively (last resort) — legacy with manual exclusions
 *
 * Results are cached in memory for 5 minutes per workspace.
 * File discovery is LAZY — only runs when a tool or handler
 * explicitly needs the file list. Never runs on workspace open.
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import log from "electron-log";
import { getFilesRecursively } from "./file_utils";
import {
    projectFilesCacheKey,
    normalizeProjectFilesScopePath,
    clearWorkspaceDiscoverySessionCache,
} from "./workspace-discovery";
import { ensureSymbolIndex, getSymbolsForFile } from "@/lib/index/ctags-index";
import { structureFromSymbols } from "@/lib/index/structure-from-symbols";

const execAsync = promisify(exec);
const logger = log.scope("project-files");

/** Cached CLI probes — avoid spawning fd/rg when not installed (log noise on every scan). */
let fdCliAvailable: boolean | undefined;
let rgCliAvailable: boolean | undefined;

async function probeCli(command: string): Promise<boolean> {
  try {
    await execAsync(command, { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function isFdAvailable(): Promise<boolean> {
  if (fdCliAvailable === undefined) {
    fdCliAvailable = await probeCli("fd --version");
    if (!fdCliAvailable) {
      logger.debug(
        "[project-files] fd not installed — using ripgrep for discovery (optional: brew install fd)",
      );
    }
  }
  return fdCliAvailable;
}

async function isRipgrepAvailable(): Promise<boolean> {
  if (rgCliAvailable === undefined) {
    rgCliAvailable = await probeCli("rg --version");
    if (!rgCliAvailable) {
      logger.debug(
        "[project-files] ripgrep not installed — will use legacy directory walk if needed",
      );
    }
  }
  return rgCliAvailable;
}

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
    strategy: "git" | "fd" | "ripgrep" | "walk";
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
/** Coalesce concurrent discovery for the same workspace before the result is cached. */
const inFlightPromises = new Map<string, Promise<ProjectFilesResult>>();

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
        /** Workspace-relative folder (e.g. packages/api). Omit when workspacePath is already the scan root. */
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

    let inflight = inFlightPromises.get(cacheKey);
    if (!inflight) {
        inflight = discoverProjectFiles(workspacePath, options);
        inFlightPromises.set(cacheKey, inflight);
        void inflight.finally(() => {
            inFlightPromises.delete(cacheKey);
        });
    }
    return inflight;
}

async function discoverProjectFiles(
    workspacePath: string,
    options?: {
        timeout?: number;
        extensions?: string[];
        scopePath?: string;
    }
): Promise<ProjectFilesResult> {
    const scope = normalizeProjectFilesScopePath(options?.scopePath);
    const cacheKey = projectFilesCacheKey(workspacePath, scope);
    const timeout = options?.timeout ?? 15_000;
    const scanRoot = scope ? path.join(workspacePath, scope) : workspacePath;

    const toScopedRelPath = (raw: string): string | null => {
        const rel = normalizeDiscoveredFile(scanRoot, raw);
        return rel ? rel.replace(/\\/g, "/") : null;
    };

    // -----------------------------------------------
    // STRATEGY 1: fd (primary, when installed)
    // -----------------------------------------------
    if (await isFdAvailable()) {
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
            cwd: scanRoot,
            timeout,
            maxBuffer: 50 * 1024 * 1024,
        });

        const files = filterDiscoveryPaths(
            stdout
                .split("\n")
                .map((f) => toScopedRelPath(f))
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
            "[project-files] fd failed, trying ripgrep",
            {
                error: err instanceof Error ? err.message : String(err),
            }
        );
    }
    }

    // -----------------------------------------------
    // STRATEGY 2: ripgrep --files (fallback)
    // -----------------------------------------------
    if (await isRipgrepAvailable()) {
    try {
        const args = ["--files", "--hidden"];

        if (options?.extensions?.length) {
            const glob = `*.{${options.extensions.join(",")}}`;
            args.push("--glob", glob);
        }

        const { stdout } = await execAsync("rg " + args.join(" "), {
            cwd: scanRoot,
            timeout,
            maxBuffer: 50 * 1024 * 1024,
        });

        const files = filterDiscoveryPaths(
            stdout
                .split("\n")
                .map((f) => toScopedRelPath(f))
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
            "[project-files] ripgrep failed, falling back to legacy scan",
            {
                error: err instanceof Error ? err.message : String(err),
            }
        );
    }
    }

    // -----------------------------------------------
    // STRATEGY 3: getFilesRecursively (last resort)
    // -----------------------------------------------
    logger.warn(
        "[project-files] fd and ripgrep unavailable — using legacy recursive scan. " +
            "Results may include build artifacts.",
    );
    const accessWarnings: string[] = [];
    const legacyFiles = getFilesRecursively(scanRoot, scanRoot, accessWarnings).map(
        (f) => f.replace(/\\/g, "/"),
    );
    const filteredLegacy = filterDiscoveryPaths(legacyFiles);
    const result: ProjectFilesResult = {
        files: filteredLegacy,
        strategy: "walk",
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
