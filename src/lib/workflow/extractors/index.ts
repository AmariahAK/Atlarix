/**
 * Extractors - project → AppMap (per language)
 * Used for: project → Atlaflow (n8n-level detail)
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { AppMap, Runtime } from "../app_map_types";
import { extractAppMapFromNode } from "./node";
import { extractAppMapFromPython } from "./python";

export { extractAppMapFromNode } from "./node";
export { extractAppMapFromPython } from "./python";

/** Detect runtime from project root (package.json, pyproject.toml, go.mod, etc.) */
export async function detectRuntime(projectPath: string): Promise<Runtime | null> {
  let names: string[] = [];
  try {
    names = await fs.readdir(projectPath);
  } catch {
    return null;
  }
  if (names.includes("package.json")) return "node";
  if (names.includes("pyproject.toml") || names.includes("requirements.txt")) return "python";
  if (names.includes("go.mod")) return "go";
  if (names.includes("Cargo.toml")) return "rust";
  if (names.includes("Gemfile")) return "ruby";
  if (names.some((n) => n.endsWith(".csproj")) || names.includes("*.sln")) return "dotnet";
  if (names.includes("composer.json")) return "php";
  if (names.includes("mix.exs")) return "elixir";
  if (names.includes("deno.json") || names.includes("deno.jsonc")) return "deno";
  if (names.includes("bun.lockb")) return "bun";
  if (names.includes("pom.xml") || names.includes("build.gradle")) return "java";
  return null;
}

/**
 * Extract AppMap from project. Uses language-specific extractors when available.
 */
export async function extractAppMap(projectPath: string): Promise<AppMap | null> {
  const runtime = await detectRuntime(projectPath);
  if (!runtime) return null;

  if (runtime === "node") {
    return extractAppMapFromNode(projectPath);
  }

  if (runtime === "python") {
    return extractAppMapFromPython(projectPath);
  }

  if (runtime === "bun") {
    const appMap = await extractAppMapFromNode(projectPath);
    return { ...appMap, runtime: "bun" };
  }

  // Only Node and Python have full extractors; others use inference/ecosystem fallback
  return null;
}
