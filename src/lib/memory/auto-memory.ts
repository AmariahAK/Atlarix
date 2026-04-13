/**
 * Auto Memory: append structured notes to `.atlarix/ATLARIX.md` after substantive turns.
 */

import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";

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
  /** When false, do not write ATLARIX.md. Default true. */
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
    const dir = path.join(ctx.workspacePath, ".atlarix");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "ATLARIX.md");
    let body = "";
    try {
      body = await fs.readFile(filePath, "utf8");
    } catch {
      body = "# ATLARIX workspace notes\n";
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
