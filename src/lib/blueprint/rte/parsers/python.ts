/**
 * Python RTE parser
 * Extracts APIs, functions, classes from .py using regex patterns.
 * Framework detection: FastAPI, Django, Flask.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BlueprintNode, FrameworkInfo, LanguageParser } from "./types";
import { parseSourceToTree } from "@/lib/pivot/parsers/parse-source-tree";
import { extractBlueprintNodesFromPython } from "@/lib/pivot/parsers/python-ts-parser";

const FASTAPI_ROUTE = /@(?:app|router)\s*\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi;
const FLASK_ROUTE = /@(?:app|bp|[\w]+)\s*\.route\s*\(\s*["']([^"']+)["']/gi;
const DJANGO_PATH = /path\s*\(\s*["']([^"']+)["']/gi;
const FUNCTION_DECL = /^\s*def\s+(\w+)\s*\(/gm;
const CLASS_DECL = /^\s*class\s+(\w+)/gm;

function safeId(prefix: string, file: string, name: string, index: number): string {
  return `${prefix}_${file.replace(/[^a-zA-Z0-9]/g, "_")}_${name}_${index}`;
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

async function parseFile(
  absolutePath: string,
  projectPath: string,
  nodes: BlueprintNode[]
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(absolutePath, "utf-8");
  } catch {
    return;
  }
  const relPath = path.relative(projectPath, absolutePath).replace(/\\/g, "/");
  const lineOf = (offset: number) => (content.slice(0, offset).match(/\n/g) || []).length + 1;

  let m: RegExpExecArray | null;

  let usedTreeSitter = false;
  const pyTree = parseSourceToTree(content, absolutePath);
  if (pyTree) {
    nodes.push(...extractBlueprintNodesFromPython(content, pyTree, relPath, nodes.length));
    usedTreeSitter = true;
  }

  FASTAPI_ROUTE.lastIndex = 0;
  while ((m = FASTAPI_ROUTE.exec(content)) !== null) {
    const method = (m[1] || "get").toUpperCase();
    const routePath = m[2] || "/";
    nodes.push({
      id: safeId("api", relPath, `${method}-${routePath}`, nodes.length),
      type: "api",
      name: `${method} ${routePath}`,
      file: relPath,
      line: lineOf(m.index),
      method,
      path: routePath,
      description: routePath,
    });
  }

  FLASK_ROUTE.lastIndex = 0;
  while ((m = FLASK_ROUTE.exec(content)) !== null) {
    const routePath = m[1] || "/";
    nodes.push({
      id: safeId("api", relPath, routePath, nodes.length),
      type: "api",
      name: routePath,
      file: relPath,
      line: lineOf(m.index),
      path: routePath,
      description: routePath,
    });
  }

  DJANGO_PATH.lastIndex = 0;
  while ((m = DJANGO_PATH.exec(content)) !== null) {
    const routePath = m[1] || "/";
    nodes.push({
      id: safeId("api", relPath, routePath, nodes.length),
      type: "api",
      name: routePath,
      file: relPath,
      line: lineOf(m.index),
      path: routePath,
      description: routePath,
    });
  }

  if (!usedTreeSitter) {
    CLASS_DECL.lastIndex = 0;
    while ((m = CLASS_DECL.exec(content)) !== null) {
      const name = m[1] || "Anonymous";
      nodes.push({
        id: safeId("cls", relPath, name, nodes.length),
        type: "class",
        name,
        file: relPath,
        line: lineOf(m.index),
      });
    }

    FUNCTION_DECL.lastIndex = 0;
    while ((m = FUNCTION_DECL.exec(content)) !== null) {
      const name = m[1] || "anonymous";
      nodes.push({
        id: safeId("fn", relPath, name, nodes.length),
        type: "function",
        name,
        file: relPath,
        line: lineOf(m.index),
      });
    }
  }
}

async function detectFrameworkFromFiles(files: string[]): Promise<FrameworkInfo> {
  let fastapi = 0;
  let django = 0;
  let flask = 0;
  for (const f of files) {
    let content: string;
    try {
      content = await fs.readFile(f, "utf-8");
    } catch {
      continue;
    }
    if (/@(?:app|router)\s*\.(get|post)|from\s+fastapi|import\s+fastapi/i.test(content)) fastapi++;
    if (/urlpatterns|path\s*\(|from\s+django|django\.conf/i.test(content)) django++;
    if (/@.*\.route|from\s+flask|import\s+flask/i.test(content)) flask++;
  }
  if (fastapi > 0) return { name: "fastapi", confidence: 0.9 };
  if (django > 0) return { name: "django", confidence: 0.85 };
  if (flask > 0) return { name: "flask", confidence: 0.85 };
  return { name: "python", confidence: 0.5 };
}

export const pythonParser: LanguageParser = {
  async parse(files: string[]): Promise<BlueprintNode[]> {
    const nodes: BlueprintNode[] = [];
    const base = commonBase(files);
    for (const filePath of files) {
      const abs = path.isAbsolute(filePath) ? filePath : filePath;
      await parseFile(abs, base, nodes);
    }
    return nodes;
  },
  async detectFramework(files: string[]): Promise<FrameworkInfo> {
    return detectFrameworkFromFiles(files);
  },
};
