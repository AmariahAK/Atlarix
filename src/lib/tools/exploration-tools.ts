import * as fs from "fs";
import * as path from "path";
import { ToolRegistry, ToolCategory } from "./registry";
import { isExcludedDir } from "@/ipc/utils/file_utils";
import { parseFileStructure } from "@/lib/workspace/tree-sitter-utils";
import {
  getSessionLedger,
  updateSessionLedger,
  formatSessionLedger,
} from "../tasks/session-ledger";

const MAX_FILES_PER_CALL = 50;
const MAX_NODES_IN_DIAGRAM = 30;
const MAX_TOKENS_PER_FILE_RESULT = 500;

interface EntryPoint {
  path: string;
  type: "package-main" | "tsconfig" | "convention" | "most-imported";
  description: string;
}

const CONVENTIONAL_ENTRY_FILES = [
  "index.ts", "index.js", "main.ts", "main.js",
  "app.ts", "app.js", "__init__.py", "mod.rs", "lib.rs",
  "index.py", "main.py", "server.ts", "server.js",
];

export function registerExplorationTools(): void {
  ToolRegistry.register({
    name: "generate_workspace_map",
    description: `Generate a Mermaid architecture diagram for specific files or directories. Use this to understand the structure of a part of the codebase before diving in. Provide specific paths — never pass the entire workspace root. Start with the directory most relevant to the current task.`,
    category: ToolCategory.ANALYSIS,
    cost: 1,
    requiresWorkspace: true,
    isReadOnly: true,
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          description: "Specific files or dirs to map. Max 5 paths per call.",
          items: { type: "string", description: "File or directory path" },
        },
        depth: {
          type: "number",
          description: "How deep to traverse. Default 2.",
          default: 2,
          minimum: 1,
          maximum: 3,
        },
        focus: {
          type: "string",
          description: "What to focus on",
          default: "overview",
          enum: ["overview", "imports", "exports", "classes", "functions"],
        },
      },
      required: ["paths"],
    },
    handler: async (params: any, context: any) => {
      const { paths, depth = 2, focus = "overview" } = params;
      const workspacePath = context.workspacePath;

      if (!workspacePath) {
        return { error: "No workspace open" };
      }

      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 5) {
        return { error: "Provide 1-5 paths" };
      }

      const treeSitterAvailable = await import("@/lib/analysis/treesitter-parser").then(m => m.isTreeSitterAvailable());
      if (!treeSitterAvailable) {
        return { error: "Tree-sitter not available" };
      }

      const filesScanned: string[] = [];
      const nodes: string[] = [];
      const edges: string[] = [];

      for (const p of paths) {
        const fullPath = path.isAbsolute(p) ? p : path.join(workspacePath, p);

        try {
          const stat = await fs.promises.stat(fullPath);

          if (stat.isDirectory()) {
            const dirFiles = await scanDirectory(fullPath, workspacePath, depth, filesScanned);
            filesScanned.push(...dirFiles);

            const dirName = path.basename(p);

            if (focus === "overview" || focus === "imports") {
              nodes.push(`    ${sanitizeNodeId(dirName)}["${dirName}"]`);
            }

            for (const file of dirFiles.slice(0, 20)) {
              const relPath = path.relative(fullPath, file);
              const fileName = path.basename(file);
              const ext = path.extname(file);

              nodes.push(`    ${sanitizeNodeId(fileName)}["${fileName}"]`);

              if (filesScanned.length <= MAX_NODES_IN_DIAGRAM) {
                edges.push(`    ${sanitizeNodeId(dirName)} --> ${sanitizeNodeId(fileName)}`);
              }
            }
          } else if (stat.isFile()) {
            filesScanned.push(fullPath);

            const fileName = path.basename(p);
            nodes.push(`    ${sanitizeNodeId(fileName)}["${fileName}"]`);

            const parsed = await parseFileStructure(fullPath, ["functions", "classes", "imports"], {
              workspacePath,
              relativePath: path.relative(workspacePath, fullPath),
            });

            if (parsed) {
              if (focus === "functions" || focus === "overview") {
                for (const fn of parsed.functions.slice(0, 10)) {
                  nodes.push(`    ${sanitizeNodeId(fn)}((${fn}))`);
                  edges.push(`    ${sanitizeNodeId(fileName)} -.-> ${sanitizeNodeId(fn)}`);
                }
              }

              if (focus === "classes" || focus === "overview") {
                for (const cls of parsed.classes.slice(0, 5)) {
                  nodes.push(`    ${sanitizeNodeId(cls)}["${cls}"]`);
                  edges.push(`    ${sanitizeNodeId(fileName)} -.-> ${sanitizeNodeId(cls)}`);
                }
              }

              if (focus === "imports" || focus === "overview") {
                for (const imp of parsed.imports.slice(0, 10)) {
                  const impName = path.basename(imp.replace(/['"]/g, ""));
                  edges.push(`    ${sanitizeNodeId(fileName)} --> ${sanitizeNodeId(impName)}`);
                }
              }
            }
          }
        } catch (err) {
        }
      }

      if (filesScanned.length > MAX_FILES_PER_CALL) {
        return {
          diagram: "",
          filesScanned,
          nodeCount: nodes.length,
          truncated: true,
          error: `Scan exceeded ${MAX_FILES_PER_CALL} files limit`,
        };
      }

      const diagram = `graph TD\n${nodes.join("\n")}\n${edges.join("\n")}`;

      return {
        diagram,
        filesScanned: filesScanned.slice(0, MAX_FILES_PER_CALL),
        nodeCount: nodes.length,
        truncated: nodes.length > MAX_NODES_IN_DIAGRAM,
      };
    },
  });

  ToolRegistry.register({
    name: "scan_file_structure",
    description: `Use Tree-sitter to extract the structure of specific files — classes, functions, imports, exports — without reading full content. Use this before read_file to decide if a file is actually relevant to the current task. Much cheaper than reading the full file.`,
    category: ToolCategory.ANALYSIS,
    cost: 1,
    requiresWorkspace: true,
    isReadOnly: true,
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Specific files to scan. Max 10.",
          items: { type: "string", description: "File path" },
        },
        extract: {
          type: "array",
          description: "What to extract",
          items: {
            type: "string",
            enum: ["imports", "exports", "functions", "classes", "types", "constants"],
          },
        },
      },
      required: ["files"],
    },
    handler: async (params: any, context: any) => {
      const { files, extract = ["imports", "exports", "functions"] } = params;
      const workspacePath = context.workspacePath;

      if (!workspacePath) {
        return { error: "No workspace open" };
      }

      if (!Array.isArray(files) || files.length === 0 || files.length > 10) {
        return { error: "Provide 1-10 files" };
      }

      const treeSitterAvailable = await import("@/lib/analysis/treesitter-parser").then(m => m.isTreeSitterAvailable());
      if (!treeSitterAvailable) {
        return { error: "Tree-sitter not available" };
      }

      const results: any[] = [];

      for (const filePath of files) {
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(workspacePath, filePath);

        const parsed = await parseFileStructure(fullPath, extract, {
          workspacePath,
          relativePath: path.relative(workspacePath, fullPath),
        });

        if (!parsed) {
          results.push({ path: filePath, error: "Cannot parse file type" });
          continue;
        }

        const result: any = { path: filePath };

        let tokenCount = 0;
        const addField = (field: string, value: any) => {
          const serialized = JSON.stringify(value);
          tokenCount += serialized.length / 4;
          if (tokenCount > MAX_TOKENS_PER_FILE_RESULT) {
            return false;
          }
          result[field] = value;
          return true;
        };

        if (extract.includes("imports")) {
          if (!addField("imports", parsed.imports)) break;
        }
        if (extract.includes("exports")) {
          if (!addField("exports", parsed.exports)) break;
        }
        if (extract.includes("functions")) {
          if (!addField("functions", parsed.functions)) break;
        }
        if (extract.includes("classes")) {
          if (!addField("classes", parsed.classes)) break;
        }
        if (extract.includes("types")) {
          if (!addField("types", parsed.types || [])) break;
        }
        if (extract.includes("constants")) {
          if (!addField("constants", parsed.constants || [])) break;
        }

        if (tokenCount > MAX_TOKENS_PER_FILE_RESULT) {
          result.truncated = true;
          result.note = "Use read_file for full content";
        }

        results.push(result);
      }

      return { results, scannedCount: results.length };
    },
  });

  ToolRegistry.register({
    name: "compress_context",
    description: `Compress older completed parts of this conversation to free up context for the current task. Call this when you have just finished a major subtask and want to continue with a clean context. Only compress completed work — never the current active task or recent tool outputs.`,
    category: ToolCategory.ANALYSIS,
    cost: 0,
    requiresWorkspace: false,
    isReadOnly: true,
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "What to compress",
          enum: ["completed_tasks", "old_tool_outputs", "everything_old"],
        },
        reason: {
          type: "string",
          description: "Why you are compressing now (optional)",
        },
      },
      required: ["scope"],
    },
    handler: async (params: any, context: any) => {
      const { scope, reason } = params;
      const messages = context?.messages ?? [];
      const tierLimit = context?.tierLimit ?? 100_000;

      const { compressContext } = await import("@/lib/context/compaction");
      const result = await compressContext(messages, { scope, reason }, tierLimit);

      return {
        compressed: result.compressed,
        tokensSaved: result.tokensSaved,
        summary: result.summary,
        separator: `── Context compacted · ${result.tokensSaved.toLocaleString()} tokens freed ──`,
      };
    },
  });

  ToolRegistry.register({
    name: "find_entry_points",
    description: `Find the main entry points and key files for a specific directory or module. Use this first when you don't know where to start in an unfamiliar part of the codebase.`,
    category: ToolCategory.ANALYSIS,
    cost: 1,
    requiresWorkspace: true,
    isReadOnly: true,
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Directory to inspect",
        },
      },
      required: ["directory"],
    },
    handler: async (params: any, context: any) => {
      const { directory } = params;
      const workspacePath = context.workspacePath;

      if (!workspacePath) {
        return { error: "No workspace open" };
      }

      const fullPath = path.isAbsolute(directory)
        ? directory
        : path.join(workspacePath, directory);

      try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isDirectory()) {
          return { error: "Not a directory" };
        }
      } catch {
        return { error: "Directory not found" };
      }

      const candidates: EntryPoint[] = [];

      try {
        const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
        const files = entries.filter(e => !e.isDirectory()).map(e => e.name);
        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

        for (const file of files) {
          const ext = path.extname(file);
          const base = path.basename(file, ext);

          if (CONVENTIONAL_ENTRY_FILES.includes(file)) {
            const fullFilePath = path.join(fullPath, file);
            let description = file;

            try {
              const content = await fs.promises.readFile(fullFilePath, "utf-8");
              const firstLine = content.split("\n")[0];
              if (firstLine.startsWith("//") || firstLine.startsWith("#")) {
                description = firstLine.slice(0, 80);
              } else if (firstLine.includes("/**")) {
                const match = content.match(/\/\*\*\s*([^\n]+)/);
                if (match) description = match[1];
              }
            } catch {
            }

            candidates.push({
              path: path.join(directory, file),
              type: "convention",
              description,
            });
          }
        }

        const packageJson = files.find(f => f === "package.json");
        if (packageJson) {
          try {
            const content = await fs.promises.readFile(path.join(fullPath, packageJson), "utf-8");
            const pkg = JSON.parse(content);
            const main = pkg.main || pkg.exports?.["."]?.import || pkg.exports?.["."]?.require;
            if (main) {
              candidates.unshift({
                path: path.join(directory, main),
                type: "package-main",
                description: `package.json main: ${main}`,
              });
            }
            if (pkg.exports) {
              const exports = Object.keys(pkg.exports).filter(e => e.startsWith("."));
              for (const exp of exports.slice(0, 3)) {
                const expPath = pkg.exports[exp].import || pkg.exports[exp].require;
                if (expPath) {
                  candidates.push({
                    path: path.join(directory, expPath),
                    type: "package-main",
                    description: `export: ${exp}`,
                  });
                }
              }
            }
          } catch {
          }
        }

        const pyprojectToml = files.find(f => f === "pyproject.toml");
        if (pyprojectToml) {
          try {
            const content = await fs.promises.readFile(path.join(fullPath, pyprojectToml), "utf-8");
            if (content.includes("[tool.poetry]") || content.includes("[project]")) {
              const match = content.match(/name\s*=\s*"([^"]+)"/);
              if (match) {
                candidates.unshift({
                  path: path.join(directory, pyprojectToml),
                  type: "package-main",
                  description: `Python project: ${match[1]}`,
                });
              }
            }
          } catch {
          }
        }

        const cargoToml = files.find(f => f === "Cargo.toml");
        if (cargoToml) {
          try {
            const content = await fs.promises.readFile(path.join(fullPath, cargoToml), "utf-8");
            if (content.includes("[package]")) {
              const match = content.match(/name\s*=\s*"([^"]+)"/);
              if (match) {
                candidates.unshift({
                  path: path.join(directory, cargoToml),
                  type: "package-main",
                  description: `Rust crate: ${match[1]}`,
                });
              }
            }
          } catch {
          }
        }

        for (const dir of dirs) {
          if (isExcludedDir(dir)) continue;
          const indexFile = path.join(fullPath, dir, "index.ts");
          const indexJs = path.join(fullPath, dir, "index.js");
          if (await fileExists(indexFile)) {
            candidates.push({
              path: path.join(directory, dir, "index.ts"),
              type: "convention",
              description: `${dir}/index.ts`,
            });
          } else if (await fileExists(indexJs)) {
            candidates.push({
              path: path.join(directory, dir, "index.js"),
              type: "convention",
              description: `${dir}/index.js`,
            });
          }
        }
      } catch (err: any) {
        return { error: err.message || "Failed to scan directory" };
      }

      return {
        entryPoints: candidates.slice(0, 10),
        totalFound: candidates.length,
      };
    },
  });
}

export function registerLedgerTools(): void {
  ToolRegistry.register({
    name: "update_ledger",
    description: `Update your session task ledger. Use this to track what you planned, what you have done, what files you have read or modified, and what remains. Call this at the start of any multi-step task and after each significant action. The ledger persists for the entire session.`,
    category: ToolCategory.ANALYSIS,
    cost: 0,
    requiresWorkspace: false,
    isReadOnly: false,
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "The overall task plan. Set once at start.",
        },
        completed: {
          type: "array",
          items: { type: "string" },
          description: "Actions just completed. Appended to list.",
        },
        pending: {
          type: "array",
          items: { type: "string" },
          description: "What remains to be done. Appended to list.",
        },
        filesRead: {
          type: "array",
          items: { type: "string" },
          description: "Files read this turn. Deduplicated automatically.",
        },
        filesModified: {
          type: "array",
          items: { type: "string" },
          description: "Files written or modified this turn. Deduplicated automatically.",
        },
        notes: {
          type: "string",
          description: "Any important observations or decisions.",
        },
      },
    },
    handler: async (args: any) => {
      const { chatId } = args._chatSessionId != null ? { chatId: args._chatSessionId } : { chatId: 0 };
      if (!chatId) return { error: "No chat session" };

      const {
        plan,
        completed,
        pending,
        filesRead,
        filesModified,
        notes,
      } = args;

      const updated = updateSessionLedger(chatId, {
        plan,
        completed,
        pending,
        filesRead,
        filesModified,
        notes,
      });

      return { success: true, ledger: updated };
    },
  });

  ToolRegistry.register({
    name: "read_ledger",
    description: `Read your current session task ledger to understand what you have done so far and what remains. Call this whenever you need to check your progress on a multi-step task.`,
    category: ToolCategory.ANALYSIS,
    cost: 0,
    requiresWorkspace: false,
    isReadOnly: true,
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async (args: any) => {
      const chatId = args._chatSessionId as number | undefined;
      if (!chatId) return { error: "No chat session" };

      const ledger = getSessionLedger(chatId);
      if (!ledger) {
        return { exists: false, message: "No ledger for this session. Call update_ledger first." };
      }

      return {
        exists: true,
        ledger: {
          plan: ledger.plan,
          completed: ledger.completed ?? [],
          pending: ledger.pending ?? [],
          filesRead: ledger.filesRead ?? [],
          filesModified: ledger.filesModified ?? [],
          notes: ledger.notes ?? [],
          startedAt: ledger.startedAt,
          lastUpdated: ledger.lastUpdated,
        },
        formatted: formatSessionLedger(ledger),
      };
    },
  });
}

async function scanDirectory(
  dirPath: string,
  workspacePath: string,
  depth: number,
  filesScanned: string[]
): Promise<string[]> {
  if (depth <= 0 || filesScanned.length >= MAX_FILES_PER_CALL) {
    return [];
  }

  const result: string[] = [];

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (filesScanned.length >= MAX_FILES_PER_CALL) break;

      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;

        const subDir = path.join(dirPath, entry.name);
        const subFiles = await scanDirectory(subDir, workspacePath, depth - 1, filesScanned);
        result.push(...subFiles);
      } else if (entry.isFile()) {
        const fullPath = path.join(dirPath, entry.name);
        // Always store as workspace-relative path
        const relPath = path.relative(workspacePath, fullPath).replace(/\\/g, "/");
        result.push(relPath);
        filesScanned.push(relPath);
      }
    }
  } catch {
  }

  return result;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeNodeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");
}

let registered = false;
export function ensureExplorationToolsRegistered(): void {
  if (!registered) {
    registerExplorationTools();
    registerLedgerTools();
    registered = true;
  }
}