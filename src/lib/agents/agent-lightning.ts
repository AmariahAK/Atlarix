/**
 * v2.1: Agent Lightning - offline trace collection and training entry point.
 * When collectData is true, append traces to .atlarix/training_data/ for future optimization.
 * No emojis; use "Agent Lightning" and icon (Zap/Sparkles) in UI.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("agent-lightning");

const TRAINING_DATA_DIR = ".atlarix/training_data";
const TRACES_FILE = "traces.jsonl";

export interface AgentLightningTrace {
  timestamp: number;
  chatId: number;
  requestSnippet: string;
  agentMode?: string;
  agentsUsed?: string[];
  finalSnippet: string;
  tokenCount?: number;
  cost?: number;
}

/**
 * Append a trace when collectData is enabled. Call after a turn completes.
 */
export async function recordTrace(
  workspacePath: string,
  trace: AgentLightningTrace
): Promise<void> {
  const dir = path.join(workspacePath, TRAINING_DATA_DIR);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, TRACES_FILE);
    const line = JSON.stringify(trace) + "\n";
    await fs.promises.appendFile(file, line);
    logger.debug("Agent Lightning trace recorded");
  } catch (err) {
    logger.warn("Failed to record Agent Lightning trace:", err);
  }
}

/**
 * Entry point for manual or scheduled training run.
 * v2.1: Minimal - no optimization yet; just a placeholder.
 */
export async function runAgentLightningTraining(_workspacePath: string): Promise<{
  success: boolean;
  message: string;
}> {
  logger.info("Agent Lightning training run (placeholder)");
  return {
    success: true,
    message: "Agent Lightning training not yet implemented. Trace collection is active when enabled in settings.",
  };
}
