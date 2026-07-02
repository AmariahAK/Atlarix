/**
 * Atlarix unified edit_file tool (Pass 7 consolidation; v13.8 absorbed write_file;
 * v14.8.7 collapsed to write + replace).
 *
 * The single file-mutation tool. Two operations under one schema:
 *   - write:   create a new file or fully overwrite an existing one (`content`)
 *   - replace: find `old_content` (exact, or via the self-healing match cascade)
 *              and replace with `new_content`
 *
 * The line-number ops (insert/delete/section) were removed — weak models can't
 * count lines reliably, so they were the most error-prone surface; write+replace
 * cover every case. Matching is delegated to the robust cascade in edit-match.ts
 * (ported from opencode), and over-escaped content is repaired via edit-escape.ts.
 *
 * Plan-mode and Ask-mode gating is preserved: Ask denies all mutation; Plan
 * allows only the .atlarix/*.md docs.
 */

import * as fs from "fs";
import * as path from "path";
import log from "electron-log";
import { assertReadablePath } from "@/lib/security/env-secret-paths";
import { ToolRegistry } from "./registry";
import { enrichPermissionWithBlastRadius } from "./permissions/enrich-blast-radius";
import { isAtlarixDocWritePath } from "../project-memory";
import { findReplacement } from "./edit-match";
import { suggestClosestPath } from "./workspace-file-hints";
import {
  analyzeEscaping,
  repairOverEscaped,
  OVER_ESCAPE_REPAIR_NOTICE,
  OVER_ESCAPE_AMBIGUOUS_ERROR,
} from "./edit-escape";

const logger = log.scope("edit-tools");

type EditOperation = "write" | "replace";

interface EditFileArgs {
  path: string;
  operation: EditOperation;
  description?: string;
  content?: string;
  old_content?: string;
  new_content?: string;
  workspace?: string;
  chatMode?: string;
  agentMode?: string;
  _chatSessionId?: number;
  workspaceId?: number;
}

function normalizeRelativePath(input: string): string {
  return input.replace(/^\/workspace\//, "").replace(/^workspace\//, "").replace(/^\/+/, "");
}

function isAtlarixPlanFile(relPath: string): boolean {
  return isAtlarixDocWritePath(relPath.replace(/\\/g, "/"));
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
    // v14.8.7 §F: mirror read_file's "did-you-mean" grounding so a mistyped or
    // just-renamed path gives the model a concrete next step, not a dead end.
    let msg = `File not found: ${normalizedPath}`;
    if (workspaceRoot) {
      const suggestion = await suggestClosestPath(workspaceRoot, normalizedPath).catch(() => null);
      if (suggestion) {
        msg += ` — did you mean "${suggestion}"? Re-read it with read_file to get the exact current content before editing.`;
      }
    }
    return { ok: false as const, error: { error: msg, operation } };
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
  /** Audit note (fuzzy-match drift) surfaced to the model + activity card. */
  notice?: string;
  metadata?: Awaited<ReturnType<typeof enrichPermissionWithBlastRadius>>;
}) {
  const { normalizedPath, newContent, oldContent, description, reasoning, diff, operation, notice, metadata } = args;
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
      ...(notice ? { notice } : {}),
    },
    reasoning,
    ...(metadata ? { metadata } : {}),
  };
}

async function permissionPayloadWithBlastRadius(
  workspace: string | undefined,
  args: Omit<Parameters<typeof permissionPayload>[0], "metadata">,
  blastOpts?: { agentMode?: string; chatSessionId?: number; workspaceId?: number },
) {
  const metadata = workspace
    ? await enrichPermissionWithBlastRadius(workspace, args.normalizedPath, blastOpts)
    : undefined;
  return permissionPayload({ ...args, metadata });
}

async function runWrite(
  args: EditFileArgs,
  normalizedPath: string,
  fullPath: string,
  workspace?: string,
  blastOpts?: { agentMode?: string; chatSessionId?: number; workspaceId?: number },
) {
  const { content, description } = args;
  if (content === undefined) {
    return {
      error: "operation=write requires content (the full file body to create or overwrite)",
      operation: "edit_file",
    };
  }

  // v14.8.7 §B: repair model-emitted over-escaping (literal \n where real line
  // breaks were intended) before the body reaches disk; hard-block ambiguous
  // cases so we never silently corrupt a file that legitimately contains a \n.
  const escapeVerdict = analyzeEscaping(content);
  if (escapeVerdict === "ambiguous") {
    return { error: OVER_ESCAPE_AMBIGUOUS_ERROR, operation: "edit_file" };
  }
  const effectiveContent = escapeVerdict === "repair" ? repairOverEscaped(content) : content;
  const escapeNotice = escapeVerdict === "repair" ? OVER_ESCAPE_REPAIR_NOTICE : undefined;
  if (escapeNotice) {
    logger.warn(`[edit_file] auto-corrected over-escaped content for write`);
  }

  // Detect create vs overwrite so the approval card reads "Creating" / "Modifying"
  // and the diff shows the prior body (mirrors the old write_file behavior).
  let fileType: "create" | "update" = "create";
  let oldContent: string | undefined;
  if (workspace) {
    try {
      assertReadablePath(normalizedPath, workspace);
      await fs.promises.access(fullPath);
      fileType = "update";
      oldContent = await fs.promises.readFile(fullPath, "utf-8");
    } catch {
      fileType = "create";
    }
  }

  const metadata = workspace
    ? await enrichPermissionWithBlastRadius(workspace, normalizedPath, blastOpts)
    : undefined;

  return {
    __permission_required: true,
    operation: "edit_file",
    preview: {
      path: normalizedPath,
      content: effectiveContent,
      ...(oldContent !== undefined ? { oldContent } : {}),
      description: escapeNotice
        ? `${description ?? (fileType === "update" ? "Overwrite file" : "Create file")} (over-escaped content auto-corrected)`
        : (description ?? (fileType === "update" ? "Overwrite file" : "Create file")),
      type: fileType,
      lines: effectiveContent.split("\n").length,
      ...(escapeNotice ? { notice: escapeNotice } : {}),
    },
    reasoning: `${fileType === "update" ? "Modifying" : "Creating"} ${normalizedPath}: ${description ?? "(no description)"}`,
    ...(metadata ? { metadata } : {}),
  };
}

async function runReplace(
  args: EditFileArgs,
  normalizedPath: string,
  fullPath: string,
  workspace?: string,
  blastOpts?: { agentMode?: string; chatSessionId?: number; workspaceId?: number },
) {
  const { old_content, new_content, description } = args;
  if (!old_content || new_content === undefined) {
    return { error: "operation=replace requires old_content and new_content", operation: "edit_file" };
  }
  const r = await readFileSafe(fullPath, normalizedPath, "edit_file", workspace);
  if (!r.ok) return r.error;

  // v14.8.7 §B: repair over-escaped new_content before it splices in; hard-block
  // ambiguous partial over-escaping rather than corrupt the file.
  const newEscapeVerdict = analyzeEscaping(new_content);
  if (newEscapeVerdict === "ambiguous") {
    return { error: OVER_ESCAPE_AMBIGUOUS_ERROR, operation: "edit_file" };
  }
  const effectiveNew = newEscapeVerdict === "repair" ? repairOverEscaped(new_content) : new_content;
  const escapeNotice = newEscapeVerdict === "repair" ? OVER_ESCAPE_REPAIR_NOTICE : undefined;

  // v14.8.7 §D: robust match cascade (edit-match.ts) — a near-miss self-heals
  // instead of erroring, with uniqueness + disproportion rails so we never edit
  // the wrong region.
  const match = findReplacement(r.content, old_content);

  if (match.kind === "none") {
    // v12 0.3: structured retry guidance (Claude Code-style) — show the
    // closest candidate region so the model can re-read and retry with exact
    // context instead of guessing.
    const lines = r.content.split("\n");
    const firstLineOfOld = old_content.split("\n")[0].trim();
    const similarLine = lines.findIndex((l) => l.includes(firstLineOfOld.slice(0, 30)));
    let hint = "";
    let nearMiss:
      | { line: number; preview: string }
      | undefined;
    if (similarLine !== -1) {
      const from = Math.max(0, similarLine - 2);
      const to = Math.min(lines.length, similarLine + 3);
      nearMiss = {
        line: similarLine + 1,
        preview: lines.slice(from, to).join("\n"),
      };
      hint = `\n\nClosest candidate at line ${similarLine + 1}:\n---\n${nearMiss.preview}\n---\nThe file likely changed since you read it. Re-read with read_file (start_line=${from + 1}, end_line=${to}) and retry with the EXACT current content as old_content.`;
    } else {
      hint =
        "\n\nNo similar content found — the file may have changed substantially since you read it, or this may be the wrong file. Re-read the file (or search for the function) before retrying.";
    }
    return {
      error: `Content to replace not found in ${normalizedPath}. old_content must match exactly (whitespace included).${hint}`,
      operation: "edit_file",
      retry: {
        reason: "no_match",
        ...(nearMiss ? { nearMiss } : {}),
        guidance: "re-read the target range, then retry with exact content",
      },
    };
  }

  if (match.kind === "multiple") {
    return {
      error: `Found ${match.occurrences} occurrences of old_content in ${normalizedPath}. Provide more surrounding context to make the match unique.`,
      operation: "edit_file",
    };
  }

  if (match.kind === "disproportionate") {
    return {
      error: `Refusing this replace: the closest match in ${normalizedPath} spans far more than old_content, so applying it would likely clobber the wrong region. Re-read the target and pass the exact, complete old_content.`,
      operation: "edit_file",
      retry: { reason: "disproportionate_match", guidance: "re-read and pass exact old_content" },
    };
  }

  // v12 (TODO 1.4): fuzzy drift is no longer silent — surface it to the model
  // (tool result `output`) and the activity/approval card so indentation-
  // sensitive files (Python/YAML) get re-verified instead of corrupted.
  let fuzzyNotice: string | undefined;
  if (match.fuzzy) {
    const matchLine = r.content.slice(0, match.index).split("\n").length;
    fuzzyNotice = `Applied with indent/EOL tolerance at line ${matchLine} — old_content did not match exactly. Re-read the edited range to verify indentation.`;
    logger.warn(
      `[edit_file] fuzzy match (indent/EOL tolerated) for ${normalizedPath} at line ${matchLine}`,
    );
  }

  const notice = [fuzzyNotice, escapeNotice].filter(Boolean).join(" ") || undefined;

  const newContent =
    r.content.slice(0, match.index) +
    effectiveNew +
    r.content.slice(match.index + match.matchLength);
  const oldLines = old_content.split("\n").length;
  const newLines = effectiveNew.split("\n").length;
  return permissionPayloadWithBlastRadius(
    workspace,
    {
      normalizedPath,
      newContent,
      oldContent: r.content,
      description: fuzzyNotice
        ? `${description ?? "Surgical replace"} (${fuzzyNotice})`
        : (description ?? "Surgical replace"),
      ...(notice ? { notice } : {}),
      operation: "edit_file",
      diff: {
        removed: oldLines,
        added: newLines,
        old_snippet: old_content.slice(0, 200) + (old_content.length > 200 ? "..." : ""),
        new_snippet: effectiveNew.slice(0, 200) + (effectiveNew.length > 200 ? "..." : ""),
      },
      reasoning: `Replace in ${normalizedPath}: ${description ?? "(no description)"} (${oldLines}→${newLines} lines)`,
    },
    blastOpts,
  );
}

ToolRegistry.register({
  name: "edit_file",
  description: `Create, overwrite, or surgically edit a file — the single tool for all file changes. Two operations:
- write: create a NEW file, or fully overwrite an existing one, with \`content\` (the complete file body)
- replace: find \`old_content\` in the file and swap it for \`new_content\`

Use "write" for a new file or a full rewrite. For ANY change to an existing file prefer "replace": pass enough surrounding context in old_content to match ONE unique spot (minor whitespace/indentation drift is tolerated automatically; an ambiguous or missing match is reported so you can re-read and retry). "replace" is faster and safer than rewriting a large file. Put REAL newlines in content/new_content — never the two characters backslash-n. Never describe an edit instead of making it.`,
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
        enum: ["write", "replace"],
        description:
          "\"replace\" for any change to an EXISTING file (surgical, safer — the default choice); \"write\" only to CREATE a new file or fully rewrite one.",
      },
      description: { type: "string", description: "Brief description of what this edit does." },
      content: {
        type: "string",
        description: "(write) Full file body to create or overwrite. Required for operation=write. Use real newlines.",
      },
      old_content: {
        type: "string",
        description: "(replace) Content to find and replace. Include enough surrounding context to match one unique spot; minor indentation/whitespace drift is tolerated.",
      },
      new_content: {
        type: "string",
        description: "(replace) Replacement content. Required for operation=replace. Use real newlines.",
      },
    },
    required: ["path", "operation"],
  },
  handler: async (rawArgs: EditFileArgs) => {
    const { path: filePath, operation, workspace, chatMode, agentMode, _chatSessionId, workspaceId } = rawArgs;
    const blastOpts = { agentMode, chatSessionId: _chatSessionId, workspaceId };

    if (chatMode === "ask") {
      return { error: "Edit operations not allowed in Ask mode. Switch to Build mode.", operation: "edit_file", denied: true };
    }

    if (!filePath) return { error: "Missing required parameter: path", operation: "edit_file" };
    if (!operation) return { error: "Missing required parameter: operation", operation: "edit_file" };

    const normalizedPath = normalizeRelativePath(filePath);

    if (chatMode === "plan" && !isAtlarixPlanFile(normalizedPath)) {
      return {
        error: "Plan mode may only edit .atlarix/atlarix.md or .atlarix/memory.md. Use the plan tool for session plans. Switch to Build for application code.",
        operation: "edit_file",
        denied: true,
      };
    }

    const fullPath = workspace ? path.join(workspace, normalizedPath) : path.resolve(normalizedPath);
    if (workspace) {
      assertReadablePath(normalizedPath, workspace);
    }

    switch (operation) {
      case "write":
        return runWrite(rawArgs, normalizedPath, fullPath, workspace, blastOpts);
      case "replace":
        return runReplace(rawArgs, normalizedPath, fullPath, workspace, blastOpts);
      default:
        return { error: `Unknown operation: ${operation}. Use write | replace.`, operation: "edit_file" };
    }
  },
});
