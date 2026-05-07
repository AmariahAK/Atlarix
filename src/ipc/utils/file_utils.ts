import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import fsExtra from "fs-extra";
import ignore from "ignore";
import log from "electron-log";
import { generateCuteAppName } from "../../lib/utils";
import { normalizePath } from "../../../shared/normalizePath";
import {
  fsAccessDeniedUserMessage,
  isFsAccessDenied,
  warnFsPathSkipped,
} from "./fs-access-errors";

const logger = log.scope("file_utils");

const EXCLUDED_DIR_NAMES = new Set([
    "node_modules", ".git", ".next", "dist", "build", "__pycache__",
    // Python virtual environments (all variants)
    ".venv", ".venv-ci", ".venv-dev", ".venv-test", "venv", "env", ".env",
    // Python package internals — never analyze
    "site-packages", "dist-packages",
    // Timezone data — thousands of tiny files, zero value
    "tzdata", "zoneinfo",
    // AWS CDK/SAM build artifacts
    "cdk.out", ".aws-sam", ".aws-cdk",
    // Other build artifacts
    "target", "vendor", ".idea", ".vscode", "coverage",
    ".pnpm", ".pnpm-store", ".yarn", ".yarn-cache", ".turbo", ".parcel-cache",
    "out", ".nuxt", ".output", "storybook-static", ".svelte-kit", ".vercel",
    ".gradle", "DerivedData", "Pods", ".dart_tool", ".flutter_tools",
    ".mypy_cache", ".ruff_cache", ".pytest_cache",
    // General
    ".nyc_output",
]);

export function isExcludedDir(name: string): boolean {
    if (EXCLUDED_DIR_NAMES.has(name)) return true;
    if (name.startsWith(".venv")) return true;
    if (name.startsWith("venv")) return true;
    return false;
}

const MAX_FILES = 10_000;
const MAX_DEPTH = 10;

function loadIgnorerSync(projectRoot: string) {
    const ig = ignore();
    try {
        const content = fs.readFileSync(path.join(projectRoot, ".atlarixignore"), "utf-8");
        if (content.trim()) ig.add(content);
    } catch {
        // no .atlarixignore — ignore no extra paths
    }
    return ig;
}

function isIgnoredByAtlarixIgnore(
    ig: ReturnType<typeof ignore>,
    fullPath: string,
    projectRoot: string,
): boolean {
    const rel = path.relative(projectRoot, fullPath).replace(/\\/g, "/");
    if (!rel) return false;
    return ig.ignores(rel) || ig.ignores(rel + "/");
}

/**
 * Iterative getFilesRecursively with hard limits.
 * - Iterative traversal (no recursion, no stack overflow)
 * - MAX_DEPTH prevents unbounded deep traversal
 * - MAX_FILES caps total files returned
 * - Symlinks skipped inline
 * - .atlarixignore respected during traversal
 * @param dir The directory to scan
 * @param baseDir The base directory for calculating relative paths
 * @param accessWarnings When set, EACCES/EPERM skips append user-visible messages here
 * @returns Array of file paths relative to the base directory
 */
export function getFilesRecursively(
  dir: string,
  baseDir: string,
  accessWarnings?: string[],
): string[] {
    const ig = loadIgnorerSync(dir);

    const results: string[] = [];
    const queue: string[] = [dir];
    const depthMap = new Map<string, number>();
    depthMap.set(dir, 0);

    while (queue.length > 0) {
        const current = queue.shift()!;
        const currentDepth = depthMap.get(current) ?? 0;

        if (currentDepth > MAX_DEPTH) continue;

        if (isIgnoredByAtlarixIgnore(ig, current, dir)) continue;

        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(current, { withFileTypes: true });
        } catch (readErr) {
            if (isFsAccessDenied(readErr)) {
                warnFsPathSkipped(current, readErr);
                accessWarnings?.push(fsAccessDeniedUserMessage(current));
            }
            continue;
        }

        for (const dirent of dirents) {
            const fullPath = path.join(current, dirent.name);
            const relPath = path.relative(baseDir, fullPath);

            if (dirent.isSymbolicLink()) continue;

            if (isIgnoredByAtlarixIgnore(ig, fullPath, dir)) continue;

            if (dirent.isDirectory()) {
                if (isExcludedDir(dirent.name)) continue;
                depthMap.set(fullPath, currentDepth + 1);
                queue.push(fullPath);
            } else {
                results.push(relPath);
                if (results.length >= MAX_FILES) {
                    logger.warn(
                        `getFilesRecursively: hit ${MAX_FILES} file limit at ${fullPath}, stopping traversal`,
                    );
                    return results;
                }
            }
        }
    }

    return results;
}

export async function copyDirectoryRecursive(
  source: string,
  destination: string,
) {
  await fsPromises.mkdir(destination, { recursive: true });
  const entries = await fsPromises.readdir(source, { withFileTypes: true });
  // Why do we sort? This ensures stable ordering of files across platforms
  // which is helpful for tests (and has no practical downsides).
  entries.sort();

  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      // Exclude node_modules directories
      if (entry.name !== "node_modules") {
        await copyDirectoryRecursive(srcPath, destPath);
      }
    } else {
      await fsPromises.copyFile(srcPath, destPath);
    }
  }
}

export async function writeMigrationFile(
  appPath: string,
  queryContent: string,
  queryDescription?: string,
): Promise<string> {
  const migrationsDir = path.join(appPath, "supabase", "migrations");
  await fsExtra.ensureDir(migrationsDir);

  const files = await fsExtra.readdir(migrationsDir);
  const migrationNumbers = files
    .map((file) => {
      const match = file.match(/^(\d{4})_/);
      return match ? parseInt(match[1], 10) : -1;
    })
    .filter((num) => num !== -1);

  const nextMigrationNumber =
    migrationNumbers.length > 0 ? Math.max(...migrationNumbers) + 1 : 0;
  const paddedNumber = String(nextMigrationNumber).padStart(4, "0");

  let description = "migration";
  if (queryDescription) {
    description = queryDescription.toLowerCase().replace(/[\s\W-]+/g, "_");
  } else {
    description = generateCuteAppName().replace(/-/g, "_");
  }

  const migrationFileName = `${paddedNumber}_${description}.sql`;
  const migrationFilePath = path.join(migrationsDir, migrationFileName);

  await fsExtra.writeFile(migrationFilePath, queryContent);
  return normalizePath(path.relative(appPath, migrationFilePath));
}

export async function fileExists(filePath: string) {
  return fsPromises
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}
