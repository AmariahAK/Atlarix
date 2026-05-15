/**
 * Atlarix unified edit_file tool (Pass 7 consolidation).
 *
 * Replaces replace_code, insert_code, delete_lines, edit_file_section.
 * Supports four operations under one schema:
 *   - replace: find exact `old_content` and replace with `new_content`
 *   - insert: insert `new_content` at `line` (1-indexed; 0 = beginning)
 *   - delete: delete inclusive line range [start_line, end_line]
 *   - section: replace a function/class/variable section by name
 *
 * Plan-mode and Ask-mode gating is preserved from the previous tools.
 */

import * as fs from "fs";
import * as path from "path";
import log from "electron-log";
import { assertReadablePath } from "@/lib/security/env-secret-paths";
import { ToolRegistry, ToolCategory } from "./registry";

const logger = log.scope("edit-tools");

/**
 * Locate an `oldString` inside `content` with three escalating strategies:
 *   1. Exact `indexOf` (no transformation).
 *   2. CRLF→LF normalised retry — the match index is translated back to the
 *      original (CRLF-preserving) content.
 *   3. Per-line `trimStart()` retry — tolerates indentation drift.
 *
 * Returns the original-content index + matched length so the caller can
 * splice replacement text in directly. `fuzzy: true` means a non-exact match
 * was used (callers should warn for audit). Returns `null` if all three
 * strategies fail.
 */
interface FuzzyMatch {
  index: number;
  matchLength: number;
  fuzzy: boolean;
  occurrences: number;
}

function fuzzyFindString(content: string, oldString: string): FuzzyMatch | null {
  if (oldString.length === 0) return null;

  if (content.includes(oldString)) {
    return {
      index: content.indexOf(oldString),
      matchLength: oldString.length,
      fuzzy: false,
      occurrences: content.split(oldString).length - 1,
    };
  }

  const normContent = content.replace(/\r\n/g, "\n");
  const normOld = oldString.replace(/\r\n/g, "\n");
  if (normOld !== oldString || normContent !== content) {
    if (normContent.includes(normOld)) {
      const normIdx = normContent.indexOf(normOld);
      let origIdx = 0;
      let normPos = 0;
      while (normPos < normIdx && origIdx < content.length) {
        if (content[origIdx] === "\r" && content[origIdx + 1] === "\n") {
          origIdx += 2;
        } else {
          origIdx += 1;
        }
        normPos += 1;
      }
      let endIdx = origIdx;
      let normLen = 0;
      while (normLen < normOld.length && endIdx < content.length) {
        if (content[endIdx] === "\r" && content[endIdx + 1] === "\n") {
          endIdx += 2;
        } else {
          endIdx += 1;
        }
        normLen += 1;
      }
      return {
        index: origIdx,
        matchLength: endIdx - origIdx,
        fuzzy: true,
        occurrences: normContent.split(normOld).length - 1,
      };
    }
  }

  const contentLines = content.split("\n");
  const oldLinesRaw = oldString.split("\n");
  const oldLines = oldLinesRaw.map((l) => l.trimStart());
  if (oldLines.length === 0) return null;

  const matchLineAt = (start: number): boolean => {
    if (start + oldLines.length > contentLines.length) return false;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[start + j].trimStart() !== oldLines[j]) return false;
    }
    return true;
  };

  let firstMatch = -1;
  let occurrences = 0;
  for (let k = 0; k <= contentLines.length - oldLines.length; k++) {
    if (matchLineAt(k)) {
      occurrences += 1;
      if (firstMatch === -1) firstMatch = k;
    }
  }
  if (firstMatch === -1) return null;

  let charOffset = 0;
  for (let k = 0; k < firstMatch; k++) charOffset += contentLines[k].length + 1;

  let matchLength = 0;
  for (let j = 0; j < oldLines.length; j++) {
    matchLength += contentLines[firstMatch + j].length;
    if (j < oldLines.length - 1) matchLength += 1;
  }

  return { index: charOffset, matchLength, fuzzy: true, occurrences };
}

type EditOperation = "replace" | "insert" | "delete" | "section";

interface EditFileArgs {
  path: string;
  operation: EditOperation;
  description?: string;
  old_content?: string;
  new_content?: string;
  line?: number;
  start_line?: number;
  end_line?: number;
  section_identifier?: string;
  workspace?: string;
  chatMode?: string;
}

function normalizeRelativePath(input: string): string {
  return input.replace(/^\/workspace\//, "").replace(/^workspace\//, "").replace(/^\/+/, "");
}

function isAtlarixPlanFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return /(^|\/)\.atlarix\/ATLARIX_PLAN\.md$/.test(norm) || /(^|\/)\.atlarix\/ATLARIX\.md$/i.test(norm);
}

async function readFileSafe(
  fullPath: string,
  normalizedPath: string,
  operation: string,
  workspaceRoot?: string,
) {
  try {
    if (workspaceRoot) {
      assertReadablePath(normalizedPath, workspaceRoot);
    }
    const content = await fs.promises.readFile(fullPath, "utf-8");
    return { ok: true as const, content };
  } catch {
    return { ok: false as const, error: { error: `File not found: ${normalizedPath}`, operation } };
  }
}

function permissionPayload(args: {
  normalizedPath: string;
  newContent: string;
  oldContent: string;
  description: string;
  reasoning: string;
  diff?: any;
  operation: string;
}) {
  const { normalizedPath, newContent, oldContent, description, reasoning, diff, operation } = args;
  return {
    __permission_required: true,
    operation,
    preview: {
      path: normalizedPath,
      content: newContent,
      oldContent,
      description,
      type: "update" as const,
      lines: newContent.split("\n").length,
      ...(diff ? { diff } : {}),
    },
    reasoning,
  };
}

async function runReplace(args: EditFileArgs, normalizedPath: string, fullPath: string, workspace?: string) {
  const { old_content, new_content, description } = args;
  if (!old_content || new_content === undefined) {
    return { error: "operation=replace requires old_content and new_content", operation: "edit_file" };
  }
  const r = await readFileSafe(fullPath, normalizedPath, "edit_file", workspace);
  if (!r.ok) return r.error;

  const match = fuzzyFindString(r.content, old_content);
  if (!match) {
    const lines = r.content.split("\n");
    const firstLineOfOld = old_content.split("\n")[0].trim();
    const similarLine = lines.findIndex((l) => l.includes(firstLineOfOld.slice(0, 30)));
    let hint = "";
    if (similarLine !== -1) {
      hint = `\n\nSimilar content at line ${similarLine + 1}. Use read_file with start_line=${Math.max(1, similarLine - 2)}, end_line=${similarLine + 5} to inspect.`;
    }
    return {
      error: `Content to replace not found in ${normalizedPath}. old_content must match exactly (whitespace included).${hint}`,
      operation: "edit_file",
    };
  }

  if (match.occurrences > 1) {
    return {
      error: `Found ${match.occurrences} occurrences of old_content in ${normalizedPath}. Provide more surrounding context to make the match unique.`,
      operation: "edit_file",
    };
  }

  if (match.fuzzy) {
    logger.warn(
      `[edit_file] fuzzy match (indent/EOL tolerated) for ${normalizedPath}`,
    );
  }

  const newContent =
    r.content.slice(0, match.index) +
    new_content +
    r.content.slice(match.index + match.matchLength);
  const oldLines = old_content.split("\n").length;
  const newLines = new_content.split("\n").length;
  return permissionPayload({
    normalizedPath,
    newContent,
    oldContent: r.content,
    description: description ?? "Surgical replace",
    operation: "edit_file",
    diff: {
      removed: oldLines,
      added: newLines,
      old_snippet: old_content.slice(0, 200) + (old_content.length > 200 ? "..." : ""),
      new_snippet: new_content.slice(0, 200) + (new_content.length > 200 ? "..." : ""),
    },
    reasoning: `Replace in ${normalizedPath}: ${description ?? "(no description)"} (${oldLines}→${newLines} lines)`,
  });
}

async function runInsert(
  args: EditFileArgs,
  normalizedPath: string,
  fullPath: string,
  workspace?: string,
) {
  const { line, new_content, description } = args;
  if (line === undefined || !new_content) {
    return { error: "operation=insert requires line and new_content", operation: "edit_file" };
  }
  const r = await readFileSafe(fullPath, normalizedPath, "edit_file", workspace);
  if (!r.ok) return r.error;

  const lines = r.content.split("\n");
  if (line < 0 || line > lines.length) {
    return {
      error: `Invalid line ${line}. File has ${lines.length} lines (use 0 for start, ${lines.length} for end).`,
      operation: "edit_file",
    };
  }

  const codeLines = new_content.split("\n");
  const newLines = [...lines.slice(0, line), ...codeLines, ...lines.slice(line)];
  const newContent = newLines.join("\n");
  return permissionPayload({
    normalizedPath,
    newContent,
    oldContent: r.content,
    description: description ?? "Insert lines",
    operation: "edit_file",
    diff: {
      inserted_at: line,
      lines_added: codeLines.length,
      snippet: new_content.slice(0, 200) + (new_content.length > 200 ? "..." : ""),
    },
    reasoning: `Insert ${codeLines.length} lines at ${line} in ${normalizedPath}: ${description ?? "(no description)"}`,
  });
}

async function runDelete(
  args: EditFileArgs,
  normalizedPath: string,
  fullPath: string,
  workspace?: string,
) {
  const { start_line, end_line, description } = args;
  if (start_line === undefined || end_line === undefined) {
    return { error: "operation=delete requires start_line and end_line", operation: "edit_file" };
  }
  const r = await readFileSafe(fullPath, normalizedPath, "edit_file", workspace);
  if (!r.ok) return r.error;

  const lines = r.content.split("\n");
  if (start_line < 1 || end_line > lines.length || start_line > end_line) {
    return {
      error: `Invalid range ${start_line}-${end_line}. File has ${lines.length} lines.`,
      operation: "edit_file",
    };
  }

  const deletedLines = lines.slice(start_line - 1, end_line);
  const deletedContent = deletedLines.join("\n");
  const newLines = [...lines.slice(0, start_line - 1), ...lines.slice(end_line)];
  const newContent = newLines.join("\n");
  return permissionPayload({
    normalizedPath,
    newContent,
    oldContent: r.content,
    description: description ?? "Delete lines",
    operation: "edit_file",
    diff: {
      deleted_range: `${start_line}-${end_line}`,
      lines_removed: deletedLines.length,
      deleted_snippet: deletedContent.slice(0, 200) + (deletedContent.length > 200 ? "..." : ""),
    },
    reasoning: `Delete ${start_line}-${end_line} from ${normalizedPath}: ${description ?? "(no description)"}`,
  });
}

async function runSection(
  args: EditFileArgs,
  normalizedPath: string,
  fullPath: string,
  workspace?: string,
) {
  const { section_identifier, new_content, description } = args;
  if (!section_identifier || new_content === undefined) {
    return { error: "operation=section requires section_identifier and new_content", operation: "edit_file" };
  }
  const r = await readFileSafe(fullPath, normalizedPath, "edit_file", workspace);
  if (!r.ok) return r.error;

  const lines = r.content.split("\n");
  const escaped = section_identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`function\\s+${escaped}\\s*\\(`),
    new RegExp(`const\\s+${escaped}\\s*=`),
    new RegExp(`class\\s+${escaped}\\s*{`),
    new RegExp(`export\\s+function\\s+${escaped}\\s*\\(`),
  ];

  let startLine = -1;
  let endLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) {
      startLine = i;
      let braceCount = 0;
      let inSection = false;
      for (let j = i; j < lines.length; j++) {
        const lineText = lines[j];
        for (const ch of lineText) {
          if (ch === "{") {
            braceCount++;
            inSection = true;
          } else if (ch === "}") {
            braceCount--;
          }
        }
        if (inSection && braceCount === 0) {
          endLine = j;
          break;
        }
      }
      break;
    }
  }

  if (startLine === -1) {
    return { error: `Section "${section_identifier}" not found in ${normalizedPath}`, operation: "edit_file" };
  }

  const before = lines.slice(0, startLine);
  const after = lines.slice(endLine + 1);
  const newLines = [...before, new_content, ...after];
  const newContent = newLines.join("\n");
  return permissionPayload({
    normalizedPath,
    newContent,
    oldContent: r.content,
    description: description ?? `Replace section ${section_identifier}`,
    operation: "edit_file",
    reasoning: `Section edit (${section_identifier}) in ${normalizedPath}: ${description ?? "(no description)"}`,
  });
}

ToolRegistry.register({
  name: "edit_file",
  category: ToolCategory.FILE,
  description: `Edit a file with surgical precision. Supports four operations:
- replace: find exact text and replace with new text (safest; requires old_content to match exactly)
- insert: insert new_content at a specific line (1-indexed; 0 = beginning of file)
- delete: delete a range of lines [start_line..end_line] (1-indexed, inclusive)
- section: replace a named function/class/variable section without computing line numbers

Prefer "replace" for code changes — it requires matching the existing content exactly. Use "insert" for adding new code blocks. Use "delete" only for removing dead code. Use "section" when you know the symbol name but not the exact text.`,
  cost: 3,
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root.",
      },
      operation: {
        type: "string",
        enum: ["replace", "insert", "delete", "section"],
        description: "Edit operation to perform.",
      },
      description: { type: "string", description: "Brief description of what this edit does." },
      old_content: {
        type: "string",
        description: "(replace) Exact content to find and replace. Must match exactly, whitespace included.",
      },
      new_content: {
        type: "string",
        description: "(replace/insert/section) New content to write.",
      },
      line: {
        type: "number",
        description: "(insert) Line number to insert AFTER (1-indexed). Use 0 to insert at the beginning.",
      },
      start_line: {
        type: "number",
        description: "(delete) First line to delete (1-indexed, inclusive).",
      },
      end_line: {
        type: "number",
        description: "(delete) Last line to delete (1-indexed, inclusive).",
      },
      section_identifier: {
        type: "string",
        description: "(section) Function/class/variable name to find and replace.",
      },
    },
    required: ["path", "operation"],
  },
  handler: async (rawArgs: EditFileArgs) => {
    const { path: filePath, operation, workspace, chatMode } = rawArgs;

    if (chatMode === "ask") {
      return { error: "Edit operations not allowed in Ask mode. Switch to Build mode.", operation: "edit_file", denied: true };
    }

    if (!filePath) return { error: "Missing required parameter: path", operation: "edit_file" };
    if (!operation) return { error: "Missing required parameter: operation", operation: "edit_file" };

    const normalizedPath = normalizeRelativePath(filePath);

    if (chatMode === "plan" && !isAtlarixPlanFile(normalizedPath)) {
      return {
        error: "Plan mode may only edit .atlarix/ATLARIX_PLAN.md or .atlarix/ATLARIX.md. Switch to Build for application code.",
        operation: "edit_file",
        denied: true,
      };
    }

    const fullPath = workspace ? path.join(workspace, normalizedPath) : path.resolve(normalizedPath);
    if (workspace) {
      assertReadablePath(normalizedPath, workspace);
    }

    switch (operation) {
      case "replace":
        return runReplace(rawArgs, normalizedPath, fullPath, workspace);
      case "insert":
        return runInsert(rawArgs, normalizedPath, fullPath, workspace);
      case "delete":
        return runDelete(rawArgs, normalizedPath, fullPath, workspace);
      case "section":
        return runSection(rawArgs, normalizedPath, fullPath, workspace);
      default:
        return { error: `Unknown operation: ${operation}. Use replace | insert | delete | section.`, operation: "edit_file" };
    }
  },
});
