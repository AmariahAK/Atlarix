/**
 * Ground the model in on-disk file contents for the last completed ledger step (up to 3 written paths).
 * Built async before ContextAssembler; injected as a protected system prefix (not tier-trimmed blob).
 */

import * as fs from "fs/promises";
import * as path from "node:path";
import { getLedger, hydrateLedgerFromDisk } from "./task-ledger";

const MAX_PATHS = 3;
/** Beyond this, show first HEAD + last TAIL only (max ~100 lines of body). */
const LINE_CAP = 100;
const HEAD_LINES = 50;
const TAIL_LINES = 50;

function pickLastCompletedStep(
  steps: import("./task-ledger").TaskStep[],
): import("./task-ledger").TaskStep | null {
  const done = steps.filter((s) => s.status === "done");
  if (done.length === 0) return null;
  return [...done].sort((a, b) => {
    const ta = a.completedAt ?? 0;
    const tb = b.completedAt ?? 0;
    if (tb !== ta) return tb - ta;
    return b.id - a.id;
  })[0];
}

export async function buildFileSystemTruthBlock(opts: {
  turnId: string;
  workspacePath: string;
}): Promise<string> {
  const { turnId, workspacePath } = opts;
  if (!turnId?.trim() || !workspacePath?.trim()) return "";

  let ledger = getLedger(turnId);
  if (!ledger) {
    ledger = await hydrateLedgerFromDisk(turnId, workspacePath);
  }
  if (!ledger) return "";

  const step = pickLastCompletedStep(ledger.steps);
  if (!step) return "";

  const relPaths = (step.filesWritten ?? [])
    .map((p) => String(p).trim())
    .filter(Boolean)
    .slice(0, MAX_PATHS);
  if (relPaths.length === 0) return "";

  const blocks: string[] = [];
  for (const rel of relPaths) {
    const safeRel = rel.replace(/^\//, "");
    const full = path.join(workspacePath, safeRel);
    try {
      const raw = await fs.readFile(full, "utf8");
      const lines = raw.split(/\r?\n/);
      let body: string;
      if (lines.length > LINE_CAP) {
        const head = lines.slice(0, HEAD_LINES).join("\n");
        const tail = lines.slice(-TAIL_LINES).join("\n");
        const omitted = lines.length - HEAD_LINES - TAIL_LINES;
        body = `${head}\n\n[... ${omitted} lines omitted — file truncated to first ${HEAD_LINES} and last ${TAIL_LINES} lines]\n\n${tail}`;
      } else {
        body = raw;
      }
      blocks.push(`### ${safeRel}\n\`\`\`\n${body}\n\`\`\``);
    } catch {
      blocks.push(`### ${safeRel}\n(File missing or unreadable at workspace root.)`);
    }
  }

  const head = `[Filesystem truth — last completed step: ${step.description}]`;
  return `${head}\n\n${blocks.join("\n\n")}`.trim();
}
