/**
 * Java RTE parser (regex-first)
 * Produces Blueprint nodes for classes and top-level methods where possible.
 * Edges are populated later by edgeExtractor using import/call heuristics.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BlueprintNode, LanguageParser, FrameworkInfo } from "./types";

const CLASS_RE = /^\s*(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+)?(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
// Best-effort: method signatures (ignore constructors via name match later)
const METHOD_RE =
  /^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:[\w<>[\], ?]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

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

export const javaParser: LanguageParser = {
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
      const classNames: string[] = [];
      while ((m = CLASS_RE.exec(content)) !== null) {
        const name = m[2];
        classNames.push(name);
        nodes.push({
          id: `${fileRel}::${name}`,
          type: "class",
          name,
          file: fileRel,
          line: lineOfIndex(content, m.index),
        });
      }

      // Method nodes are helpful for debugging/blueprint navigation, but keep them limited:
      // If we detected exactly one class name, skip constructors by that name.
      const primaryClass = classNames.length === 1 ? classNames[0] : null;
      METHOD_RE.lastIndex = 0;
      while ((m = METHOD_RE.exec(content)) !== null) {
        const name = m[1];
        if (primaryClass && name === primaryClass) continue; // constructor
        // Avoid exploding node counts on large files: cap per file.
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
    // Heuristic: if we see Spring annotations, call it spring.
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
    return { name: "java", confidence: 0.4 };
  },
};

