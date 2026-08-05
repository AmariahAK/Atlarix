/**
 * Build the context block for `@`-mentioned files and folders (current workspace).
 *
 * - A mentioned FILE → its contents (capped) are injected.
 * - A mentioned FOLDER → only its file LISTING is injected (capped), so the agent
 *   then greps / reads within that scope instead of dumping a whole tree.
 *
 * Token-frugal by design (per-file + total caps). Replaces the old whole-codebase
 * "@app" dump.
 */
import * as fs from "node:fs/promises";
import log from "electron-log";
import { safeJoin } from "./path_utils";
import { listWorkspaceFilesUnder } from "./workspace-file-list";

const logger = log.scope("mention_context");

const PER_FILE_CAP = 60_000; // chars
const TOTAL_CAP = 200_000; // chars across all mentioned files
const DIR_LISTING_CAP = 200; // entries per folder

function fenceLang(relPath: string): string {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  return /^[a-z0-9]+$/.test(ext) ? ext : "";
}

export async function extractMentionedContext({
  appPath,
  files,
  dirs,
}: {
  appPath: string;
  files: string[];
  dirs: string[];
}): Promise<string> {
  if (files.length === 0 && dirs.length === 0) return "";

  const parts: string[] = [];
  let total = 0;

  for (const rel of files) {
    if (total >= TOTAL_CAP) break;
    try {
      const abs = safeJoin(appPath, rel);
      let content = await fs.readFile(abs, "utf-8");
      let truncated = false;
      if (content.length > PER_FILE_CAP) {
        content = content.slice(0, PER_FILE_CAP);
        truncated = true;
      }
      total += content.length;
      parts.push(
        `### File: ${rel}${truncated ? " (truncated)" : ""}\n\`\`\`${fenceLang(rel)}\n${content}\n\`\`\``,
      );
    } catch (error) {
      logger.warn(`Could not read mentioned file ${rel}`, error);
      parts.push(`### File: ${rel}\n(could not read this file)`);
    }
  }

  for (const rel of dirs) {
    if (total >= TOTAL_CAP) break;
    try {
      const dirFiles = await listWorkspaceFilesUnder(appPath, rel);
      // Paths come back relative to the mentioned folder; re-root them under it so
      // the agent can grep/read_file them directly.
      const rooted = dirFiles.map((f) => `${rel.replace(/\/$/, "")}/${f}`);
      const listing = rooted.slice(0, DIR_LISTING_CAP);
      const more =
        dirFiles.length > DIR_LISTING_CAP
          ? `\n…(${dirFiles.length - DIR_LISTING_CAP} more)`
          : "";
      total += listing.join("\n").length;
      parts.push(
        `### Folder: ${rel} (${dirFiles.length} files — listing only; use grep/read_file to inspect)\n${listing.join("\n")}${more}`,
      );
    } catch (error) {
      logger.warn(`Could not list mentioned folder ${rel}`, error);
      parts.push(`### Folder: ${rel}\n(could not list this folder)`);
    }
  }

  return (
    `# Referenced files & folders\n` +
    `The user referenced these with @ — included for context (read-only; not necessarily the only relevant files):\n\n` +
    parts.join("\n\n")
  );
}
