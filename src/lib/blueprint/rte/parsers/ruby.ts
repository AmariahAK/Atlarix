/**
 * Ruby RTE parser (regex-first)
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BlueprintNode, LanguageParser, FrameworkInfo } from "./types";

const CLASS_MOD_RE = /^\s*(class|module)\s+([A-Za-z_][A-Za-z0-9_:]*)/gm;
const DEF_RE = /^\s*def\s+(self\.)?([a-zA-Z_][a-zA-Z0-9_!?=]*)/gm;

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

export const rubyParser: LanguageParser = {
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

      CLASS_MOD_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CLASS_MOD_RE.exec(content)) !== null) {
        const name = m[2];
        nodes.push({
          id: `${fileRel}::${name}`,
          type: "class",
          name,
          file: fileRel,
          line: lineOfIndex(content, m.index),
        });
      }

      DEF_RE.lastIndex = 0;
      while ((m = DEF_RE.exec(content)) !== null) {
        if (nodes.filter((n) => n.file === fileRel && n.type === "function").length >= 40) break;
        const name = `${m[1] ?? ""}${m[2]}`;
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
    // Rails is better detected via workspace analyzer, but keep a cheap heuristic here.
    if (files.some((f) => f.replace(/\\/g, "/").endsWith("config/routes.rb"))) {
      return { name: "rails", confidence: 0.6 };
    }
    try {
      for (const abs of files.slice(0, 50)) {
        const c = await fs.readFile(abs, "utf-8");
        if (/\bgem\s+["']rails["']/.test(c)) return { name: "rails", confidence: 0.6 };
      }
    } catch {
      // ignore
    }
    return { name: "ruby", confidence: 0.4 };
  },
};

