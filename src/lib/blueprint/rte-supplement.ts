/**
 * Supplement thin ctags+RTE node sets with file-tree beacons.
 */

import log from "electron-log";
import type { RTEParseResult } from "@/lib/blueprint/rte/parsers/types";
import { isThinRteNodeSet } from "@/lib/blueprint/blueprint-quality";
import { generateBlueprintFromFileTree } from "@/lib/blueprint/rte/file-tree-bridge";

const logger = log.scope("rte:supplement");

function normFile(f: string): string {
  return f.replace(/\\/g, "/").replace(/^\//, "");
}

/**
 * When ctags returns few symbols, union file-tree file beacons for uncovered paths.
 */
export async function supplementThinRteResult(
  projectPath: string,
  result: RTEParseResult,
  fileCount: number,
): Promise<{ result: RTEParseResult; supplemented: boolean }> {
  if (!isThinRteNodeSet(result.nodes, fileCount)) {
    return { result, supplemented: false };
  }

  const ft = await generateBlueprintFromFileTree(projectPath, {
    framework: result.framework,
    atlarixIgnoreSource: result.atlarixIgnoreSource,
  });

  const coveredFiles = new Set(result.nodes.map((n) => normFile(n.file)));
  const existingIds = new Set(result.nodes.map((n) => n.id));
  const added = ft.nodes.filter((n) => {
    const f = normFile(n.file);
    if (!f || coveredFiles.has(f)) return false;
    if (existingIds.has(n.id)) return false;
    coveredFiles.add(f);
    existingIds.add(n.id);
    return true;
  });

  if (added.length === 0) {
    return { result, supplemented: false };
  }

  logger.info("supplementThinRteResult: merged file-tree beacons", {
    projectPath,
    ctagsNodes: result.nodes.length,
    added: added.length,
    total: result.nodes.length + added.length,
  });

  return {
    result: {
      ...result,
      nodes: [...result.nodes, ...added],
    },
    supplemented: true,
  };
}
