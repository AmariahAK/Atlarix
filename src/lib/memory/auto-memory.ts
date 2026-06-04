/**
 * Auto Memory: append structured notes to `.atlarix/memory.md` after
 * substantive turns. memory.md is the agent-maintained project knowledge file
 * (v10) — auto-memory bullets live in a dedicated section at the end so they
 * never clobber the agent-authored stack/architecture notes above.
 *
 * (Previously wrote `.atlarix/ATLARIX.md`, which the legacy-file migration
 * archived on every prompt build — those notes were silently destroyed.)
 */

import * as fs from "fs/promises";
import log from "electron-log";
import { getMemoryMdPath, getAtlarixDirPath } from "../project-memory";

const logger = log.scope("auto-memory");

const SECTION = "## Auto Memory";

export type AutoMemoryTurnContext = {
  workspacePath: string;
  chatId: number;
  /** Tool display names or ids from the turn (best-effort). */
  toolsUsed: string[];
  /** Short user-facing summary of what happened. */
  summary: string;
  /** 0–1 heuristic confidence; below minConfidence skips write. */
  confidence: number;
  minConfidence: number;
  /** When false, do not write memory.md. Default true. */
  writeToFile?: boolean;
};

function formatBullet(ctx: AutoMemoryTurnContext): string {
  const tools =
    ctx.toolsUsed.length > 0 ? ` Tools: ${ctx.toolsUsed.slice(0, 12).join(", ")}.` : "";
  return `- [chat ${ctx.chatId}] ${ctx.summary.trim()}${tools}`;
}

export async function appendAutoMemoryIfEligible(ctx: AutoMemoryTurnContext): Promise<boolean> {
  if (ctx.writeToFile === false) return false;
  if (ctx.confidence < ctx.minConfidence) return false;
  if (!ctx.summary.trim()) return false;
  try {
    await fs.mkdir(getAtlarixDirPath(ctx.workspacePath), { recursive: true });
    const filePath = getMemoryMdPath(ctx.workspacePath);
    let body = "";
    try {
      body = await fs.readFile(filePath, "utf8");
    } catch {
      body = "# Project memory\n";
    }
    const line = formatBullet(ctx);
    if (!body.includes(SECTION)) {
      body = `${body.trimEnd()}\n\n${SECTION}\n\n${line}\n`;
    } else {
      const insertAt = body.indexOf(SECTION) + SECTION.length;
      body = `${body.slice(0, insertAt)}\n${line}\n${body.slice(insertAt)}`;
    }
    await fs.writeFile(filePath, body, "utf8");
    return true;
  } catch (e) {
    logger.warn("appendAutoMemoryIfEligible failed:", e);
    return false;
  }
}
