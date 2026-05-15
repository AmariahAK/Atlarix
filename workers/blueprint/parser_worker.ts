/**
 * worker_threads entry: oxc parseSync off the main process.
 */

import { parentPort } from "node:worker_threads";
import { oxcParseProgram } from "../../src/lib/blueprint/rte/parsers/oxc-parse";
import { walkProgramToNodes } from "../../src/lib/blueprint/rte/parsers/oxc-program-walk";
import type { BlueprintNode } from "../../src/lib/blueprint/rte/parsers/types";

export type ParserWorkerRequest = {
  id: number;
  filePath: string;
  source: string;
  relPath: string;
  idOffset: number;
};

export type ParserWorkerResponse = {
  id: number;
  nodes: BlueprintNode[];
  error?: string;
};

parentPort?.on("message", (msg: ParserWorkerRequest) => {
  try {
    const program = oxcParseProgram(msg.filePath, msg.source);
    if (!program) {
      const res: ParserWorkerResponse = { id: msg.id, nodes: [] };
      parentPort?.postMessage(res);
      return;
    }
    const nodes = walkProgramToNodes(program, msg.relPath, msg.idOffset);
    parentPort?.postMessage({ id: msg.id, nodes });
  } catch (err) {
    parentPort?.postMessage({
      id: msg.id,
      nodes: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
