/**
 * LSP-backed read-only tools for Build / Debug / Review.
 * Thin wrappers over `lsp-client` (spawned language servers).
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { ToolRegistry, ToolCategory, createParameters, stringParam } from "./registry";
import {
  requestLspDefinition,
  requestLspDiagnosticsAfterSync,
  requestLspHover,
  requestLspReferences,
} from "../lsp/lsp-client";

function resolveWorkspacePath(workspace: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(workspace, filePath);
  return path.normalize(abs);
}

function assertInsideWorkspace(workspace: string, absPath: string): string | null {
  const root = path.resolve(workspace);
  const target = path.resolve(absPath);
  if (!target.startsWith(root + path.sep) && target !== root) {
    return "Path escapes workspace root.";
  }
  if (!fs.existsSync(target)) {
    return `File not found: ${absPath}`;
  }
  return null;
}

ToolRegistry.register({
  name: "lsp_diagnostics",
  description:
    "Pull LSP diagnostics for a file after edits (TypeScript, Python, etc. when a server is available). Prefer this before claiming a fix is clean.",
  category: ToolCategory.ANALYSIS,
  cost: 1,
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      path: stringParam("File path relative to workspace root or absolute"),
    },
    ["path"],
  ),
  handler: async (args: { path: string; workspace?: string }) => {
    const workspace = args.workspace?.trim();
    if (!workspace) {
      return JSON.stringify({ success: false, error: "No workspace" });
    }
    const abs = resolveWorkspacePath(workspace, args.path);
    const err = assertInsideWorkspace(workspace, abs);
    if (err) return JSON.stringify({ success: false, error: err });
    const diags = await requestLspDiagnosticsAfterSync(abs, workspace);
    return JSON.stringify({
      success: true,
      path: abs,
      diagnostics: diags ?? [],
      count: Array.isArray(diags) ? diags.length : 0,
    });
  },
});

ToolRegistry.register({
  name: "lsp_hover",
  description: "LSP hover information (types, docs) at a position. Line and column are 0-based.",
  category: ToolCategory.ANALYSIS,
  cost: 1,
  requiresWorkspace: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      path: stringParam("File path relative to workspace root or absolute"),
      line: { type: "integer", description: "0-based line" },
      character: { type: "integer", description: "0-based UTF-16 offset in line" },
    },
    ["path", "line", "character"],
  ),
  handler: async (args: { path: string; line: number; character: number; workspace?: string }) => {
    const workspace = args.workspace?.trim();
    if (!workspace) {
      return JSON.stringify({ success: false, error: "No workspace" });
    }
    const abs = resolveWorkspacePath(workspace, args.path);
    const err = assertInsideWorkspace(workspace, abs);
    if (err) return JSON.stringify({ success: false, error: err });
    const hover = await requestLspHover(abs, workspace, args.line, args.character);
    return JSON.stringify({ success: true, path: abs, hover });
  },
});

ToolRegistry.register({
  name: "lsp_definitions",
  description: "LSP go-to-definition from a position. Line and column are 0-based.",
  category: ToolCategory.ANALYSIS,
  cost: 1,
  requiresWorkspace: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      path: stringParam("File path relative to workspace root or absolute"),
      line: { type: "integer", description: "0-based line" },
      character: { type: "integer", description: "0-based UTF-16 offset in line" },
    },
    ["path", "line", "character"],
  ),
  handler: async (args: { path: string; line: number; character: number; workspace?: string }) => {
    const workspace = args.workspace?.trim();
    if (!workspace) {
      return JSON.stringify({ success: false, error: "No workspace" });
    }
    const abs = resolveWorkspacePath(workspace, args.path);
    const err = assertInsideWorkspace(workspace, abs);
    if (err) return JSON.stringify({ success: false, error: err });
    const loc = await requestLspDefinition(abs, workspace, args.line, args.character);
    return JSON.stringify({ success: true, path: abs, locations: loc });
  },
});

ToolRegistry.register({
  name: "lsp_references",
  description: "LSP find references from a symbol position. Line and column are 0-based.",
  category: ToolCategory.ANALYSIS,
  cost: 1,
  requiresWorkspace: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      path: stringParam("File path relative to workspace root or absolute"),
      line: { type: "integer", description: "0-based line" },
      character: { type: "integer", description: "0-based UTF-16 offset in line" },
    },
    ["path", "line", "character"],
  ),
  handler: async (args: { path: string; line: number; character: number; workspace?: string }) => {
    const workspace = args.workspace?.trim();
    if (!workspace) {
      return JSON.stringify({ success: false, error: "No workspace" });
    }
    const abs = resolveWorkspacePath(workspace, args.path);
    const err = assertInsideWorkspace(workspace, abs);
    if (err) return JSON.stringify({ success: false, error: err });
    const refs = await requestLspReferences(abs, workspace, args.line, args.character);
    return JSON.stringify({ success: true, path: abs, references: refs });
  },
});
