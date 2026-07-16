import fsAsync from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import { gitIsIgnored } from "../ipc/utils/git_utils";
import log from "electron-log";
import { IS_TEST_BUILD } from "../ipc/utils/test_utils";
import { glob } from "glob";
import { AppChatContext } from "../lib/schemas";
import { readSettings } from "@/main/settings";
import { AsyncVirtualFileSystem } from "../../shared/VirtualFilesystem";
import { isExcludedDir } from "@/ipc/utils/file_utils";
import {
  isFsAccessDenied,
  warnFsPathSkipped,
} from "@/ipc/utils/fs-access-errors";

const logger = log.scope("utils/codebase");

// File extensions to include in the extraction
const ALLOWED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".css",
  ".html",
  ".md",
  ".astro",
  ".vue",
  ".svelte",
  ".scss",
  ".sass",
  ".less",
  // Oftentimes used as config (e.g. package.json, vercel.json) or data files (e.g. translations)
  ".json",
  // GitHub Actions
  ".yml",
  ".yaml",
  // Needed for Capacitor projects
  ".xml",
  ".plist",
  ".entitlements",
  ".kt",
  ".java",
  ".gradle",
  ".swift",
  // Edge cases
  // https://github.com/norahlabs/atlarix/issues/880
  ".py",
  // https://github.com/norahlabs/atlarix/issues/1221
  ".php",
];

// Directories to always exclude
// Normally these files are excluded by the gitignore, but sometimes
// people don't have their gitignore setup correctly so we want to
// be conservative and never include these directories.
//
// ex: https://github.com/norahlabs/atlarix/issues/727
// Uses isExcludedDir for comprehensive coverage of .venv-*, tzdata, etc.

// Files to always exclude
const EXCLUDED_FILES = ["pnpm-lock.yaml", "package-lock.json"];

// Files to always include, regardless of extension
const ALWAYS_INCLUDE_FILES = [".gitignore"];

// Legacy substring entries for docs/back-compat; env files are matched via
// `isEnvSecretPath` (`.env`, `.env.*`, `*.env`, etc.) in shouldReadFileContents*.
/** @deprecated Prefer `isEnvSecretPath` — kept for external imports / grep */
export const ALWAYS_OMITTED_FILES = [".env", ".env.local"];

// File patterns to omit (contents will be replaced with a placeholder)
//
// Why are we not using path.join here?
// Because we have already normalized the path to use /.
//
// Note: these files are only omitted when NOT using smart context.
//
// Why do we omit these files when not using smart context?
//
// Because these files are typically low-signal and adding them
// to the context can cause users to much more quickly hit their
// free rate limits.
const OMITTED_FILES = [
  ...ALWAYS_OMITTED_FILES,
  "src/components/ui",
  "eslint.config",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "tsconfig.base.json",
  "components.json",
];

// Maximum file size to include (in bytes) - 1MB
const MAX_FILE_SIZE = 1000 * 1024;

// Maximum size for fileContentCache
const MAX_FILE_CACHE_SIZE = 500;

// File content cache with timestamps
type FileCache = {
  content: string;
  mtime: number;
};

// Cache for file contents
const fileContentCache = new Map<string, FileCache>();

// Cache for git ignored paths
const gitIgnoreCache = new Map<string, boolean>();
// Map to store .gitignore file paths and their modification times
const gitIgnoreMtimes = new Map<string, number>();

/**
 * Check if a path should be ignored based on git ignore rules
 */
async function isGitIgnored(
  filePath: string,
  baseDir: string,
): Promise<boolean> {
  try {
    // Check if any relevant .gitignore has been modified
    // Git checks .gitignore files in the path from the repo root to the file
    let currentDir = baseDir;
    const pathParts = path.relative(baseDir, filePath).split(path.sep);
    let shouldClearCache = false;

    // Check root .gitignore
    const rootGitIgnorePath = path.join(baseDir, ".gitignore");
    try {
      const stats = await fsAsync.stat(rootGitIgnorePath);
      const lastMtime = gitIgnoreMtimes.get(rootGitIgnorePath) || 0;
      if (stats.mtimeMs > lastMtime) {
        gitIgnoreMtimes.set(rootGitIgnorePath, stats.mtimeMs);
        shouldClearCache = true;
      }
    } catch {
      // Root .gitignore might not exist, which is fine
    }

    // Check .gitignore files in parent directories
    for (let i = 0; i < pathParts.length - 1; i++) {
      currentDir = path.join(currentDir, pathParts[i]);
      const gitIgnorePath = path.join(currentDir, ".gitignore");

      try {
        const stats = await fsAsync.stat(gitIgnorePath);
        const lastMtime = gitIgnoreMtimes.get(gitIgnorePath) || 0;
        if (stats.mtimeMs > lastMtime) {
          gitIgnoreMtimes.set(gitIgnorePath, stats.mtimeMs);
          shouldClearCache = true;
        }
      } catch {
        // This directory might not have a .gitignore, which is fine
      }
    }

    // Clear cache if any .gitignore was modified
    if (shouldClearCache) {
      gitIgnoreCache.clear();
    }

    const cacheKey = `${baseDir}:${filePath}`;

    if (gitIgnoreCache.has(cacheKey)) {
      return gitIgnoreCache.get(cacheKey)!;
    }

    const relativePath = path.relative(baseDir, filePath);
    const result = await gitIsIgnored({
      path: baseDir,
      filepath: relativePath,
    });

    gitIgnoreCache.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.error(`Error checking if path is git ignored: ${filePath}`, error);
    return false;
  }
}

/**
 * Read file contents with caching based on last modified time
 */
export async function readFileWithCache(
  filePath: string,
  virtualFileSystem?: AsyncVirtualFileSystem,
): Promise<string | undefined> {
  try {
    // Check virtual filesystem first if provided
    if (virtualFileSystem) {
      const virtualContent = await virtualFileSystem.readFile(filePath);
      if (virtualContent != null) {
        return virtualContent;
      }
    }

    // Get file stats to check the modification time
    const stats = await fsAsync.stat(filePath);
    const currentMtime = stats.mtimeMs;

    // If file is in cache and hasn't been modified, use cached content
    if (fileContentCache.has(filePath)) {
      const cache = fileContentCache.get(filePath)!;
      if (cache.mtime === currentMtime) {
        return cache.content;
      }
    }

    // Read file and update cache
    const rawContent = await fsAsync.readFile(filePath, "utf-8");
    const content = rawContent;
    fileContentCache.set(filePath, {
      content,
      mtime: currentMtime,
    });

    // Manage cache size by clearing oldest entries when it gets too large
    if (fileContentCache.size > MAX_FILE_CACHE_SIZE) {
      // Get the oldest 25% of entries to remove
      const entriesToDelete = Math.ceil(MAX_FILE_CACHE_SIZE * 0.25);
      const keys = Array.from(fileContentCache.keys());

      // Remove oldest entries (first in, first out)
      for (let i = 0; i < entriesToDelete; i++) {
        fileContentCache.delete(keys[i]);
      }
    }

    return content;
  } catch (error) {
    if (isFsAccessDenied(error)) {
      warnFsPathSkipped(filePath, error);
    } else {
      logger.error(`Error reading file: ${filePath}`, error);
    }
    return undefined;
  }
}

/**
 * Recursively walk a directory and collect all relevant files
 */
async function collectFiles(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];

  // Check if directory exists
  try {
    await fsAsync.access(dir);
  } catch {
    // Directory doesn't exist or is not accessible
    return files;
  }

  let entries: Dirent[];
  try {
    entries = await fsAsync.readdir(dir, { withFileTypes: true });
  } catch (readErr) {
    if (isFsAccessDenied(readErr)) {
      warnFsPathSkipped(dir, readErr);
    } else {
      logger.error(`Error reading directory ${dir}:`, readErr);
    }
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory() && isExcludedDir(entry.name)) {
      continue;
    }

    try {
      if (await isGitIgnored(fullPath, baseDir)) {
        continue;
      }

      if (entry.isDirectory()) {
        const subDirFiles = await collectFiles(fullPath, baseDir);
        files.push(...subDirFiles);
      } else if (entry.isFile()) {
        if (EXCLUDED_FILES.includes(entry.name)) {
          continue;
        }

        let stats: Stats;
        try {
          stats = await fsAsync.stat(fullPath);
        } catch (statErr) {
          if (isFsAccessDenied(statErr)) {
            warnFsPathSkipped(fullPath, statErr);
          } else {
            logger.error(`Error checking file size: ${fullPath}`, statErr);
          }
          continue;
        }
        if (stats.size > MAX_FILE_SIZE) {
          continue;
        }

        files.push(fullPath);
      }
    } catch (loopErr) {
      if (isFsAccessDenied(loopErr)) {
        warnFsPathSkipped(fullPath, loopErr);
        continue;
      }
      logger.error(`Error processing path: ${fullPath}`, loopErr);
    }
  }

  return files;
}

const OMITTED_FILE_CONTENT = "// File contents excluded from context";

/**
 * Check if file contents should be read based on extension and inclusion rules
 */
function shouldReadFileContents({
  filePath,
  normalizedRelativePath,
}: {
  filePath: string;
  normalizedRelativePath: string;
}): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  // OMITTED_FILES takes precedence - never read if omitted
  if (
    OMITTED_FILES.some((pattern) => normalizedRelativePath.includes(pattern))
  ) {
    return false;
  }

  // Check if file should be included based on extension or filename
  return (
    ALLOWED_EXTENSIONS.includes(ext) || ALWAYS_INCLUDE_FILES.includes(fileName)
  );
}

function shouldReadFileContentsForSmartContext({
  filePath,
}: {
  filePath: string;
}): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  // Check if file should be included based on extension or filename
  return (
    ALLOWED_EXTENSIONS.includes(ext) || ALWAYS_INCLUDE_FILES.includes(fileName)
  );
}

/**
 * Format a file for inclusion in the codebase extract
 */
async function formatFile({
  filePath,
  normalizedRelativePath,
  virtualFileSystem,
}: {
  filePath: string;
  normalizedRelativePath: string;
  virtualFileSystem?: AsyncVirtualFileSystem;
}): Promise<string> {
  try {
    // Check if we should read file contents
    if (!shouldReadFileContents({ filePath, normalizedRelativePath })) {
      return `<atlarix-file path="${normalizedRelativePath}">
${OMITTED_FILE_CONTENT}
</atlarix-file>

`;
    }

    const content = await readFileWithCache(filePath, virtualFileSystem);

    if (content == null) {
      return `<atlarix-file path="${normalizedRelativePath}">
// Error reading file
</atlarix-file>

`;
    }

    return `<atlarix-file path="${normalizedRelativePath}">
${content}
</atlarix-file>

`;
  } catch (error) {
    logger.error(`Error reading file: ${filePath}`, error);
    return `<atlarix-file path="${normalizedRelativePath}">
// Error reading file: ${error}
</atlarix-file>

`;
  }
}

export interface BaseFile {
  path: string;
  focused?: boolean;
  force?: boolean;
}

export interface CodebaseFile extends BaseFile {
  content: string;
}

export interface CodebaseFileReference extends BaseFile {
  fileId: string;
}

/**
 * Extract and format codebase files as a string to be included in prompts
 * @param appPath - Path to the codebase to extract
 * @param virtualFileSystem - Optional virtual filesystem to apply modifications
 * @returns Object containing formatted output and individual files
 */
export async function extractCodebase({
  appPath,
  chatContext,
  virtualFileSystem,
}: {
  appPath: string;
  chatContext: AppChatContext;
  virtualFileSystem?: AsyncVirtualFileSystem;
}): Promise<{
  formattedOutput: string;
  files: CodebaseFile[];
}> {
  const settings = readSettings();
  const isSmartContextEnabled =
    settings?.enableAtlarixPro && settings?.enableProSmartFilesContextMode;

  try {
    await fsAsync.access(appPath);
  } catch {
    return {
      formattedOutput: `# Error: Directory ${appPath} does not exist or is not accessible`,
      files: [],
    };
  }
  const startTime = Date.now();

  // Collect all relevant files
  let files = await collectFiles(appPath, appPath);

  // Apply virtual filesystem modifications if provided
  if (virtualFileSystem) {
    // Filter out deleted files
    const deletedFiles = new Set(
      virtualFileSystem
        .getDeletedFiles()
        .map((relativePath) => path.resolve(appPath, relativePath)),
    );
    files = files.filter((file) => !deletedFiles.has(file));

    // Add virtual files
    const virtualFiles = virtualFileSystem.getVirtualFiles();
    for (const virtualFile of virtualFiles) {
      const absolutePath = path.resolve(appPath, virtualFile.path);
      if (!files.includes(absolutePath)) {
        files.push(absolutePath);
      }
    }
  }

  // Collect files from contextPaths and smartContextAutoIncludes
  const { contextPaths, smartContextAutoIncludes, excludePaths } = chatContext;
  const includedFiles = new Set<string>();
  const autoIncludedFiles = new Set<string>();
  const excludedFiles = new Set<string>();

  // Add files from contextPaths
  if (contextPaths && contextPaths.length > 0) {
    for (const p of contextPaths) {
      const pattern = createFullGlobPath({
        appPath,
        globPath: p.globPath,
      });
      const matches = await glob(pattern, {
        nodir: true,
        absolute: true,
        ignore: "**/node_modules/**",
      });
      matches.forEach((file) => {
        const normalizedFile = path.normalize(file);
        includedFiles.add(normalizedFile);
      });
    }
  }

  // Add files from smartContextAutoIncludes
  if (
    isSmartContextEnabled &&
    smartContextAutoIncludes &&
    smartContextAutoIncludes.length > 0
  ) {
    for (const p of smartContextAutoIncludes) {
      const pattern = createFullGlobPath({
        appPath,
        globPath: p.globPath,
      });
      const matches = await glob(pattern, {
        nodir: true,
        absolute: true,
        ignore: "**/node_modules/**",
      });
      matches.forEach((file) => {
        const normalizedFile = path.normalize(file);
        autoIncludedFiles.add(normalizedFile);
        includedFiles.add(normalizedFile); // Also add to included files
      });
    }
  }

  // Add files from excludePaths
  if (excludePaths && excludePaths.length > 0) {
    for (const p of excludePaths) {
      const pattern = createFullGlobPath({
        appPath,
        globPath: p.globPath,
      });
      const matches = await glob(pattern, {
        nodir: true,
        absolute: true,
        ignore: "**/node_modules/**",
      });
      matches.forEach((file) => {
        const normalizedFile = path.normalize(file);
        excludedFiles.add(normalizedFile);
      });
    }
  }

  // Only filter files if contextPaths are provided
  // If only smartContextAutoIncludes are provided, keep all files and just mark auto-includes as forced
  if (contextPaths && contextPaths.length > 0) {
    files = files.filter((file) => includedFiles.has(path.normalize(file)));
  }

  // Filter out excluded files (this takes precedence over include paths)
  if (excludedFiles.size > 0) {
    files = files.filter((file) => !excludedFiles.has(path.normalize(file)));
  }

  // Sort files by modification time (oldest first)
  // This is important for cache-ability.
  const sortedFiles = await sortFilesByModificationTime([...new Set(files)]);

  // Format files and collect individual file contents
  const filesArray: CodebaseFile[] = [];
  // Serialize formatting to cap peak RSS on large workspaces (parallel was a renderer OOM vector)
  const formattedParts: string[] = [];
  for (const file of sortedFiles) {
    const normalizedRelativePath = path
      .relative(appPath, file)
      .split(path.sep)
      .join("/");
    const formattedContent = await formatFile({
      filePath: file,
      normalizedRelativePath,
      virtualFileSystem,
    });

    const isForced =
      autoIncludedFiles.has(path.normalize(file)) &&
      !excludedFiles.has(path.normalize(file));

    let fileContent: string;
    if (
      !shouldReadFileContentsForSmartContext({
        filePath: file,
      })
    ) {
      fileContent = OMITTED_FILE_CONTENT;
    } else {
      const readContent = await readFileWithCache(file, virtualFileSystem);
      fileContent = readContent ?? "// Error reading file";
    }

    filesArray.push({
      path: normalizedRelativePath,
      content: fileContent,
      force: isForced,
    });

    formattedParts.push(formattedContent);
  }

  const formattedOutput = formattedParts.join("");

  const endTime = Date.now();
  logger.log("extractCodebase: time taken", endTime - startTime);
  if (IS_TEST_BUILD) {
    // Why? For some reason, file ordering is not stable on Windows.
    // This is a workaround to ensure stable ordering, although
    // ideally we'd like to sort it by modification time which is
    // important for cache-ability.
    filesArray.sort((a, b) => a.path.localeCompare(b.path));
  }
  return {
    formattedOutput,
    files: filesArray,
  };
}

/**
 * Sort files by their modification timestamp (oldest first)
 */
async function sortFilesByModificationTime(files: string[]): Promise<string[]> {
  const fileStats: { file: string; mtime: number }[] = [];
  for (const file of files) {
    try {
      const stats = await fsAsync.stat(file);
      fileStats.push({ file, mtime: stats.mtimeMs });
    } catch (error) {
      if (isFsAccessDenied(error)) {
        warnFsPathSkipped(file, error);
      } else {
        logger.warn(`Error getting file stats for ${file}:`, error);
      }
      fileStats.push({ file, mtime: Date.now() });
    }
  }
  if (IS_TEST_BUILD) {
    // Why? For some reason, file ordering is not stable on Windows.
    // This is a workaround to ensure stable ordering, although
    // ideally we'd like to sort it by modification time which is
    // important for cache-ability.
    return fileStats
      .sort((a, b) => a.file.localeCompare(b.file))
      .map((item) => item.file);
  }
  // Sort by modification time (oldest first)
  return fileStats.sort((a, b) => a.mtime - b.mtime).map((item) => item.file);
}

function createFullGlobPath({
  appPath,
  globPath,
}: {
  appPath: string;
  globPath: string;
}): string {
  // By default the glob package treats "\" as an escape character.
  // We want the path to use forward slash for all platforms.
  return `${appPath.replace(/\\/g, "/")}/${globPath}`;
}

// ─────────────────────────────────────────────────────────────
// In-flight deduplication — prevents parallel extractCodebase
// calls (from chat + diagram + debug + etc.) from OOM-ing the
// app on large workspaces.
// ─────────────────────────────────────────────────────────────
const extractCodebaseInFlight = new Map<
  string,
  Promise<{ formattedOutput: string; files: CodebaseFile[] }>
>();

/**
 * Deduplicated extractCodebase.
 * Only one extraction runs per workspace at a time; concurrent
 * callers share the same promise.  Callers pass the same
 * { appPath, chatContext, virtualFileSystem } they would pass
 * to extractCodebase directly.
 */
export async function extractCodebaseCached({
  appPath,
  chatContext,
  virtualFileSystem,
}: {
  appPath: string;
  chatContext: AppChatContext;
  virtualFileSystem?: AsyncVirtualFileSystem;
}): Promise<{ formattedOutput: string; files: CodebaseFile[] }> {
  const cacheKey = appPath;
  const existing = extractCodebaseInFlight.get(cacheKey);
  if (existing) {
    logger.log(`[extractCodebaseCached] deduplicating in-flight extraction for ${appPath}`);
    return existing;
  }
  const promise = extractCodebase({ appPath, chatContext, virtualFileSystem });
  extractCodebaseInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    extractCodebaseInFlight.delete(cacheKey);
  }
}
