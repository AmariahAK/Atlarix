/**
 * Per-file ast-grep import + call edge extraction (shared by main process and worker).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { findInFiles, Lang, type NapiLang } from "@ast-grep/napi";
import type { RTEBlueprintEdge } from "../parsers/types";
import type { SymbolRecord } from "@/lib/index/symbol-types";
import { langForExtension } from "./lang-map";
import { ensureAstGrepDynamicLangs } from "./register-dynamic-langs";
import { nodeIdForFileLine, resolveRelativeImport } from "./resolve-edges";
import { importPatterns, IMPORT_CAPTURE } from "./rules/imports";
import { callPatterns, CALLEE_CAPTURE } from "./rules/calls";
import {
  routePatternSpecs,
  ROUTE_PATH_CAPTURE,
  ROUTE_METHOD_CAPTURE,
  normalizeRouteHttpMethod,
} from "./rules/routes";

export function buildSymbolLookup(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const byFile = new Map<string, SymbolRecord[]>();
  for (const s of symbols) {
    const key = s.path.replace(/\\/g, "/");
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(s);
  }
  return byFile;
}

function langForFile(relPath: string): NapiLang {
  ensureAstGrepDynamicLangs();
  const ext = path.extname(relPath).toLowerCase();
  return langForExtension(ext) ?? Lang.TypeScript;
}

function findSymbolIdForName(
  byFile: Map<string, SymbolRecord[]>,
  relFile: string,
  name: string,
): string | null {
  const list = byFile.get(relFile.replace(/\\/g, "/"));
  if (!list) return null;
  const hit = list.find((s) => s.name === name);
  return hit?.id ?? null;
}

export async function scanImportsForFile(
  projectRoot: string,
  relFile: string,
  byFile: Map<string, SymbolRecord[]>,
): Promise<RTEBlueprintEdge[]> {
  const edges: RTEBlueprintEdge[] = [];
  const absPath = path.join(projectRoot, relFile);
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch {
    return edges;
  }
  void content;

  const lang = langForFile(relFile);
  const fromId =
    findSymbolIdForName(byFile, relFile, path.basename(relFile, path.extname(relFile))) ??
    nodeIdForFileLine(relFile, 1, "module");

  const importPaths = new Set<string>();

  for (const importMatcher of importPatterns(lang)) {
    await new Promise<void>((resolve, reject) => {
      findInFiles(
        lang,
        { paths: [absPath], matcher: importMatcher },
        (err, nodes) => {
          if (err) {
            reject(err);
            return;
          }
          for (const n of nodes) {
            const cap = n.getMatch(IMPORT_CAPTURE)?.text();
            if (cap) importPaths.add(cap.replace(/^['"]|['"]$/g, ""));
          }
          resolve();
        },
      ).catch(reject);
    }).catch(() => {});
  }

  for (const imp of importPaths) {
    const targetRel = await resolveRelativeImport(imp, relFile, projectRoot);
    if (!targetRel) continue;
    const targetSymbols = byFile.get(targetRel);
    const toId = targetSymbols?.[0]?.id ?? nodeIdForFileLine(targetRel, 1, "module");
    edges.push({
      from: fromId,
      to: toId,
      type: "imports",
      label: imp,
    });
  }

  return edges;
}

export async function scanCallsForFile(
  projectRoot: string,
  relFile: string,
  byFile: Map<string, SymbolRecord[]>,
): Promise<RTEBlueprintEdge[]> {
  const absPath = path.join(projectRoot, relFile);
  const lang = langForFile(relFile);
  const edges: RTEBlueprintEdge[] = [];
  const seen = new Set<string>();

  const callerSymbols = byFile.get(relFile.replace(/\\/g, "/")) ?? [];
  const defaultCaller = callerSymbols[0]?.id ?? nodeIdForFileLine(relFile, 1, "module");

  for (const callMatcher of callPatterns(lang)) {
    await new Promise<void>((resolve, reject) => {
      findInFiles(
        lang,
        { paths: [absPath], matcher: callMatcher },
        (err, nodes) => {
          if (err) {
            reject(err);
            return;
          }
          for (const n of nodes) {
            const callee = n.getMatch(CALLEE_CAPTURE)?.text();
            if (!callee || !/^[a-zA-Z_$][\w$]*$/.test(callee)) continue;
            const line = n.range().start.line + 1;
            const fromId =
              callerSymbols.find((s) => s.line <= line && (s.endLine ?? s.line) >= line)?.id ??
              defaultCaller;

            for (const [, syms] of byFile) {
              const target = syms.find((s) => s.name === callee);
              if (!target) continue;
              const key = `${fromId}->${target.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              edges.push({
                from: fromId,
                to: target.id,
                type: "calls",
                label: callee,
              });
            }
          }
          resolve();
        },
      ).catch(reject);
    }).catch(() => {});
  }

  return edges;
}

export async function scanRoutesForFile(
  projectRoot: string,
  relFile: string,
  byFile: Map<string, SymbolRecord[]>,
): Promise<RTEBlueprintEdge[]> {
  const absPath = path.join(projectRoot, relFile);
  const lang = langForFile(relFile);
  const edges: RTEBlueprintEdge[] = [];
  const seen = new Set<string>();

  const callerSymbols = byFile.get(relFile.replace(/\\/g, "/")) ?? [];
  const defaultCaller = callerSymbols[0]?.id ?? nodeIdForFileLine(relFile, 1, "module");

  for (const spec of routePatternSpecs(lang)) {
    await new Promise<void>((resolve, reject) => {
      findInFiles(
        lang,
        { paths: [absPath], matcher: spec.matcher },
        (err, nodes) => {
          if (err) {
            reject(err);
            return;
          }
          for (const n of nodes) {
            const line = n.range().start.line + 1;
            const fromId =
              callerSymbols.find((s) => s.line <= line && (s.endLine ?? s.line) >= line)?.id ??
              defaultCaller;

            let httpMethod = spec.httpMethod ?? null;
            let routePath: string | null = null;

            if (spec.capturePath) {
              const cap = n.getMatch(ROUTE_PATH_CAPTURE)?.text()?.replace(/^['"]|['"]$/g, "");
              if (cap) routePath = cap;
            }
            if (spec.captureMethod) {
              const methodRaw = n.getMatch(ROUTE_METHOD_CAPTURE)?.text();
              httpMethod = normalizeRouteHttpMethod(methodRaw) ?? httpMethod;
              if (!routePath && httpMethod) {
                routePath = inferNextRoutePath(relFile);
              }
            }

            if (!httpMethod && !routePath) continue;

            const label = [httpMethod, routePath].filter(Boolean).join(" ");
            const toId = nodeIdForFileLine(
              relFile,
              line,
              `route:${httpMethod ?? "handler"}:${routePath ?? "unknown"}`,
            );
            const key = `${fromId}->${toId}:api_call`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
              from: fromId,
              to: toId,
              type: "api_call",
              label: label || "route",
            });
          }
          resolve();
        },
      ).catch(reject);
    }).catch(() => {});
  }

  return edges;
}

/** Infer App Router path from `app/.../route.ts` file location. */
function inferNextRoutePath(relFile: string): string | null {
  const norm = relFile.replace(/\\/g, "/");
  const appMatch = norm.match(/(?:^|\/)app\/(.+)\/route\.(tsx?|jsx?)$/i);
  if (appMatch) {
    const segments = appMatch[1].split("/").filter((s) => !s.startsWith("("));
    return `/${segments.join("/")}`;
  }
  const pagesMatch = norm.match(/(?:^|\/)pages\/(.+)\.(tsx?|jsx?)$/i);
  if (pagesMatch) {
    const base = pagesMatch[1].replace(/\/index$/, "");
    return `/${base}`;
  }
  return null;
}

export async function scanFileStructuralEdges(
  projectRoot: string,
  relFile: string,
  byFile: Map<string, SymbolRecord[]>,
): Promise<RTEBlueprintEdge[]> {
  const imports = await scanImportsForFile(projectRoot, relFile, byFile);
  const calls = await scanCallsForFile(projectRoot, relFile, byFile);
  const routes = await scanRoutesForFile(projectRoot, relFile, byFile);
  return [...imports, ...calls, ...routes];
}
