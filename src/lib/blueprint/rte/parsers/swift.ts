/**
 * Swift RTE parser (regex-first)
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BlueprintNode, LanguageParser, FrameworkInfo } from "./types";

const TYPE_RE = /^\s*(class|struct|enum|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const FUNC_RE = /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

function relFromAbs(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).replace(/\\/g, "/");
}

function lineOfIndex(content: string, idx: number): number {
  if (idx <= 0) return 1;
  return content.slice(0, idx).split("\n").length;
}

function commonBase(absolutePaths: string[]): string {
  if (absolutePaths.length === 0) return "";
  let base = path.dirname(absolutePaths[0]);
  for (let i = 1; i < absolutePaths.length; i++) {
    const dir = path.dirname(absolutePaths[i]);
    while (base && path.relative(base, dir).startsWith("..")) {
      base = path.dirname(base);
    }
  }
  return base;
}

export const swiftParser: LanguageParser = {
  async parse(files: string[]): Promise<BlueprintNode[]> {
    const nodes: BlueprintNode[] = [];
    const base = commonBase(files.filter((f) => path.isAbsolute(f)));

    for (const abs of files) {
      let content: string;
      try {
        content = await fs.readFile(abs, "utf-8");
      } catch {
        continue;
      }
      const fileRel = base ? relFromAbs(base, abs) : abs.replace(/\\/g, "/");

      TYPE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TYPE_RE.exec(content)) !== null) {
        const name = m[2];
        nodes.push({
          id: `${fileRel}::${name}`,
          type: "class",
          name,
          file: fileRel,
          line: lineOfIndex(content, m.index),
        });
      }

      FUNC_RE.lastIndex = 0;
      while ((m = FUNC_RE.exec(content)) !== null) {
        if (nodes.filter((n) => n.file === fileRel && n.type === "function").length >= 40) break;
        const name = m[1];
        nodes.push({
          id: `${fileRel}::${name}@${lineOfIndex(content, m.index)}`,
          type: "function",
          name,
          file: fileRel,
          line: lineOfIndex(content, m.index),
        });
      }
    }
    return nodes;
  },

  async detectFramework(files: string[]): Promise<FrameworkInfo> {
    try {
      for (const abs of files.slice(0, 80)) {
        const c = await fs.readFile(abs, "utf-8");
        if (/\bimport\s+Vapor\b/.test(c)) return { name: "vapor", confidence: 0.6 };
      }
    } catch {
      // ignore
    }
    return { name: "swift", confidence: 0.4 };
  },
};

