import * as path from "node:path";
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";

import { ProblemReport } from "../ipc_types";
import log from "electron-log";
import { WorkerInput, WorkerOutput } from "../../../shared/tsc_types";

import {
  getAtlarixDeleteTags,
  getAtlarixRenameTags,
  getAtlarixWriteTags,
} from "../utils/atlarix_tag_parser";
import { getTypeScriptCachePath } from "@/paths/paths";

const logger = log.scope("tsc");

const TS_CONFIG_CANDIDATES = ["tsconfig.app.json", "tsconfig.json"];

function hasTsConfig(appPath: string): boolean {
  return TS_CONFIG_CANDIDATES.some((config) =>
    fs.existsSync(path.join(appPath, config))
  );
}

export async function generateProblemReport({
  fullResponse,
  appPath,
}: {
  fullResponse: string;
  appPath: string;
}): Promise<ProblemReport> {
  if (!hasTsConfig(appPath)) {
    logger.info(`Skipping TSC worker for non-TypeScript workspace: ${appPath}`);
    return { problems: [] };
  }

  return new Promise((resolve, reject) => {
    // Determine the worker script path
    const workerPath = path.join(__dirname, "tsc_worker.js");

    logger.info(`Starting TSC worker for app ${appPath}`);

    // Create the worker
    const worker = new Worker(workerPath);

    /** After `message` or `error`, we call `terminate()`; Node may exit with code 1 — do not treat as failure. */
    let settled = false;

    // Handle worker messages
    worker.on("message", (output: WorkerOutput) => {
      settled = true;
      void worker.terminate();

      if (output.success && output.data) {
        logger.info(`TSC worker completed successfully for app ${appPath}`);
        resolve(output.data);
      } else {
        logger.error(`TSC worker failed for app ${appPath}: ${output.error}`);
        reject(new Error(output.error || "Unknown worker error"));
      }
    });

    // Handle worker errors
    worker.on("error", (error) => {
      if (settled) return;
      settled = true;
      logger.error(`TSC worker error for app ${appPath}:`, error);
      void worker.terminate();
      reject(error);
    });

    // Handle worker exit (only if we never got a message — e.g. crash before postMessage)
    worker.on("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        logger.error(`TSC worker exited with code ${code} for app ${appPath}`);
        reject(new Error(`Worker exited with code ${code}`));
      }
    });

    const writeTags = getAtlarixWriteTags(fullResponse);
    const renameTags = getAtlarixRenameTags(fullResponse);
    const deletePaths = getAtlarixDeleteTags(fullResponse);
    const virtualChanges = {
      deletePaths,
      renameTags,
      writeTags,
    };

    // Send input to worker
    const input: WorkerInput = {
      virtualChanges,
      appPath,
      tsBuildInfoCacheDir: getTypeScriptCachePath(),
    };

    logger.info(`Sending input to TSC worker for app ${appPath}`);

    worker.postMessage(input);
  });
}
