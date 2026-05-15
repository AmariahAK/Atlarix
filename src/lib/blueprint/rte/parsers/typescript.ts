/**
 * TypeScript/JavaScript RTE parser
 * TS/JS/JSX/TSX: oxc-parser AST extraction + regex route/framework patterns.
 * Framework detection: Express, Next.js, NestJS, Hono, Elysia.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BlueprintNode, FrameworkInfo, LanguageParser } from "./types";
import { extractNodesFromOxc, mergeBlueprintNodes } from "./oxc-extract";

const ROUTE_REG =
  /(?:app|router|server|fastify|hono)\s*\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
const ROUTE_REG_ALT = /(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]\s*[,)]/gi;
const NESTJS_ROUTE = /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
const NEXT_API_ROUTE = /(?:export\s+default\s+)?(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/gi;
const FUNCTION_DECL = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
const CLASS_DECL = /(?:export\s+)?class\s+(\w+)/g;

function safeId(prefix: string, file: string, name: string, index: number): string {
  return `${prefix}_${file.replace(/[^a-zA-Z0-9]/g, "_")}_${name}_${index}`;
}

function extractRegexNodes(
  content: string,
  relPath: string,
  idOffset: number,
  includeStructureFallback: boolean,
): BlueprintNode[] {
  const nodes: BlueprintNode[] = [];
  let idx = idOffset;
  const lineOf = (offset: number) => (content.slice(0, offset).match(/\n/g) || []).length + 1;

  let m: RegExpExecArray | null;

  ROUTE_REG.lastIndex = 0;
  while ((m = ROUTE_REG.exec(content)) !== null) {
    const method = (m[1] || "get").toUpperCase();
    const routePath = m[2] || "/";
    nodes.push({
      id: safeId("api", relPath, `${method}-${routePath}`, idx++),
      type: "api",
      name: `${method} ${routePath}`,
      file: relPath,
      line: lineOf(m.index),
      method,
      path: routePath,
      description: routePath,
    });
  }

  ROUTE_REG_ALT.lastIndex = 0;
  while ((m = ROUTE_REG_ALT.exec(content)) !== null) {
    const routePath = m[1] || "/";
    nodes.push({
      id: safeId("api", relPath, `GET-${routePath}`, idx++),
      type: "api",
      name: `GET ${routePath}`,
      file: relPath,
      line: lineOf(m.index),
      method: "GET",
      path: routePath,
      description: routePath,
    });
  }

  NESTJS_ROUTE.lastIndex = 0;
  while ((m = NESTJS_ROUTE.exec(content)) !== null) {
    const method = (m[1] || "Get").toUpperCase();
    const routePath = (m[2] || "").trim() || "/";
    nodes.push({
      id: safeId("api", relPath, `Nest-${method}-${routePath}`, idx++),
      type: "api",
      name: `${method} ${routePath}`,
      file: relPath,
      line: lineOf(m.index),
      method,
      path: routePath,
      description: routePath,
    });
  }

  NEXT_API_ROUTE.lastIndex = 0;
  while ((m = NEXT_API_ROUTE.exec(content)) !== null) {
    nodes.push({
      id: safeId("api", relPath, "route", idx++),
      type: "api",
      name: "Next.js route",
      file: relPath,
      line: lineOf(m.index),
      description: relPath,
    });
  }

  if (includeStructureFallback) {
    CLASS_DECL.lastIndex = 0;
    while ((m = CLASS_DECL.exec(content)) !== null) {
      const name = m[1] || "Anonymous";
      nodes.push({
        id: safeId("cls", relPath, name, idx++),
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
        id: safeId("fn", relPath, name, idx++),
        type: "function",
        name,
        file: relPath,
        line: lineOf(m.index),
      });
    }
  }

  return nodes;
}

async function parseFile(
  absolutePath: string,
  projectPath: string,
  nodes: BlueprintNode[],
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(absolutePath, "utf-8");
  } catch {
    return;
  }
  const relPath = path.relative(projectPath, absolutePath).replace(/\\/g, "/");
  const idOffset = nodes.length;

  const oxcResult = await extractNodesFromOxc(content, absolutePath, relPath, idOffset);
  const oxcNodes = oxcResult ?? [];
  const usedOxc = oxcResult !== null;
  const regexNodes = extractRegexNodes(content, relPath, idOffset + oxcNodes.length, !usedOxc);
  const merged = mergeBlueprintNodes(oxcNodes, regexNodes);
  nodes.push(...merged);
}

async function detectFrameworkFromFiles(files: string[]): Promise<FrameworkInfo> {
  let express = 0;
  let next = 0;
  let nest = 0;
  let hono = 0;
  for (const f of files) {
    let content: string;
    try {
      content = await fs.readFile(f, "utf-8");
    } catch {
      continue;
    }
    if (/\bexpress\b|app\.(get|post)|router\.(get|post)/i.test(content)) express++;
    if (/next\/router|'next'|"next"|getServerSideProps|getStaticProps|pages\/api|app\/api/i.test(content)) next++;
    if (/@nestjs|@Controller|@Injectable/i.test(content)) nest++;
    if (/\bhono\b|from\s+['"]hono['"]/i.test(content)) hono++;
  }
  if (nest > 0) return { name: "nestjs", confidence: 0.9 };
  if (next > 0) return { name: "next.js", confidence: 0.85 };
  if (hono > 0) return { name: "hono", confidence: 0.85 };
  if (express > 0) return { name: "express", confidence: 0.8 };
  return { name: "node", confidence: 0.5 };
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

export const typeScriptParser: LanguageParser = {
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
