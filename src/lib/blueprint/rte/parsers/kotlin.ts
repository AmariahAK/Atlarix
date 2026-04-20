/**
 * Kotlin RTE parser (regex-first)
 * Produces Blueprint nodes for classes/objects and top-level functions.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BlueprintNode, LanguageParser, FrameworkInfo } from "./types";

const CLASS_RE = /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)?(class|interface|object)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const FUN_RE = /^\s*(?:public|internal|private|protected)?\s*(?:suspend\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

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

export const kotlinParser: LanguageParser = {
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

      CLASS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CLASS_RE.exec(content)) !== null) {
        const name = m[2];
        nodes.push({
          id: `${fileRel}::${name}`,
          type: "class",
          name,
          file: fileRel,
          line: lineOfIndex(content, m.index),
        });
      }

      FUN_RE.lastIndex = 0;
      while ((m = FUN_RE.exec(content)) !== null) {
        const name = m[1];
        if (nodes.filter((n) => n.file === fileRel && n.type === "function").length >= 30) break;
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
    // Spring Boot Kotlin still uses Spring annotations; keep the same heuristic.
    try {
      for (const abs of files.slice(0, 50)) {
        const c = await fs.readFile(abs, "utf-8");
        if (/@SpringBootApplication\b|@RestController\b|org\.springframework\b/.test(c)) {
          return { name: "spring", confidence: 0.6 };
        }
      }
    } catch {
      // ignore
    }
    return { name: "kotlin", confidence: 0.4 };
  },
};

