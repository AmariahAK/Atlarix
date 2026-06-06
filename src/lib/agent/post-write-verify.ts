/**
 * v12 0.3: post-write verification — run LSP diagnostics on the files a round
 * wrote and feed ERRORS back into the loop as a user message, so the model
 * fixes them before it can claim <task_complete>. This is the logic behind
 * the `enableAutoFixProblems` setting (which had no logic until now — TODO
 * 1.2) and the AgentProfile.postWriteVerify seam left unset in 0.1.
 *
 * Lean by design: errors only (severity 1 — warnings would drown weak
 * models), bounded per-file output, and the LSP layer's own 5s diagnostics
 * timeout + broken-server cache keep latency bounded. Files without a
 * supported language server resolve to [] and are skipped silently.
 */

import path from "node:path";
import log from "electron-log";
import type { Diagnostic } from "vscode-languageserver-types";
import { requestLspDiagnosticsAfterSync } from "@/lib/lsp/lsp-client";

const logger = log.scope("post-write-verify");

/** Cap per file so one broken file can't flood the round's feedback. */
const MAX_DIAGNOSTICS_PER_FILE = 10;
/** Cap files verified per round (a huge multi-write round stays bounded). */
const MAX_FILES_PER_ROUND = 8;

const ERROR_SEVERITY = 1; // DiagnosticSeverity.Error

export function formatDiagnosticsFeedback(
  byFile: Array<{ file: string; diagnostics: Diagnostic[] }>,
): string | null {
  const blocks: string[] = [];
  for (const { file, diagnostics } of byFile) {
    const errors = diagnostics
      .filter((d) => (d.severity ?? ERROR_SEVERITY) === ERROR_SEVERITY)
      .slice(0, MAX_DIAGNOSTICS_PER_FILE);
    if (errors.length === 0) continue;
    const lines = errors.map(
      (d) =>
        `- line ${d.range.start.line + 1}: ${String(d.message).split("\n")[0]}`,
    );
    blocks.push(
      `<diagnostics file="${file}">\n${lines.join("\n")}\n</diagnostics>`,
    );
  }
  if (blocks.length === 0) return null;
  return [
    "Your recent edits introduced the following errors (language-server diagnostics). Fix them before completing the task:",
    "",
    ...blocks,
  ].join("\n");
}

/**
 * Build the AgentProfile.postWriteVerify implementation for a workspace.
 * Returns the feedback string for the engine to append as a user message,
 * or null when the round's writes are clean (or diagnostics unavailable).
 */
export function buildPostWriteVerify(
  workspacePath: string,
): (writtenPaths: string[]) => Promise<string | null> {
  return async (writtenPaths: string[]) => {
    const unique = [...new Set(writtenPaths)].slice(0, MAX_FILES_PER_ROUND);
    if (unique.length === 0) return null;
    const startedAt = Date.now();
    const results = await Promise.all(
      unique.map(async (p) => {
        const abs = path.isAbsolute(p) ? p : path.join(workspacePath, p);
        try {
          const diagnostics = await requestLspDiagnosticsAfterSync(
            abs,
            workspacePath,
          );
          return { file: p, diagnostics };
        } catch (e) {
          logger.debug(`diagnostics unavailable for ${p}: ${String(e)}`);
          return { file: p, diagnostics: [] as Diagnostic[] };
        }
      }),
    );
    const feedback = formatDiagnosticsFeedback(results);
    logger.log(
      `verified ${unique.length} file(s) in ${Date.now() - startedAt}ms — ${
        feedback ? "errors found, feeding back" : "clean"
      }`,
    );
    return feedback;
  };
}
