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
import { parseFileStructure } from "@/lib/workspace/tree-sitter-utils";

const execAsync = promisify(exec);
const logger = log.scope("project-files");

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
 * @param workspacePath - Absolute path to workspace root
 * @param options - Optional filter by extension
 */
export async function getProjectFiles(
    workspacePath: string,
    options?: {
        timeout?: number;
        extensions?: string[];
    }
): Promise<ProjectFilesResult> {
    const cacheKey = workspacePath;
    const cached = fileListCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < FILE_LIST_TTL_MS) {
        logger.info(
            `[project-files] cache hit — ${cached.result.count} files via ${cached.result.strategy}`
        );
        return cached.result;
    }

    const timeout = options?.timeout ?? 15_000;

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

        const { stdout } = await execAsync("git " + args.join(" "), {
            cwd: workspacePath,
            timeout,
            maxBuffer: 50 * 1024 * 1024,
        });

        // git ls-files returns relative paths (src/lib/foo.ts)
        // Normalize to workspace-relative immediately so all strategies return the same format
        const files = stdout
            .split("\n")
            .filter(Boolean)
            .map((f) => {
                // f is already relative from git ls-files; just normalize separators
                return f.replace(/\\/g, "/");
            });

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
                `[project-files] ${files.length} files via git ls-files`
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

        // fd always returns absolute paths; convert to workspace-relative
        const files = stdout
            .split("\n")
            .filter(Boolean)
            .map((f) => {
                const abs = f.replace(/\\/g, "/");
                return path.relative(workspacePath, abs).replace(/\\/g, "/");
            })
            .filter((f) => !f.startsWith(".."));

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

        // ripgrep --files returns absolute paths; convert to workspace-relative
        const files = stdout
            .split("\n")
            .filter(Boolean)
            .map((f) => {
                const abs = f.replace(/\\/g, "/");
                return path.relative(workspacePath, abs).replace(/\\/g, "/");
            })
            .filter((f) => !f.startsWith(".."));

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
    logger.warn(
        "[project-files] all fast strategies failed — using legacy recursive scan. " +
            "Results may include build artifacts."
    );
    const accessWarnings: string[] = [];
    // getFilesRecursively returns paths relative to workspacePath
    const legacyFiles = getFilesRecursively(
      workspacePath,
      workspacePath,
      accessWarnings,
    ).map((f) => f.replace(/\\/g, "/"));
    const result: ProjectFilesResult = {
        files: legacyFiles,
        strategy: "fallback",
        count: legacyFiles.length,
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
        fileListCache.delete(workspacePath);
    } else {
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

    for (const filePath of entryPointFiles.slice(0, 20)) {
        // Normalize to absolute: if already relative, join with workspacePath
        const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(workspacePath, filePath);
        const relPath = path.relative(workspacePath, absPath);
        const result = await parseFileStructure(absPath, ["exports", "classes", "functions"], {
            workspacePath,
            relativePath: relPath,
        });
        if (result) {
            // Key by relative path so all callers get consistent relative keys
            results[relPath] = result;
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
