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
import { resolveToolTargetPath } from "@/ipc/utils/safeWorkspaceRelativePath";
import { ToolRegistry } from "./registry";
import { findReplacement, reindentReplacement, unescapeString } from "./edit-match";
import { mergeElision } from "./edit-merge";
import { suggestClosestPath } from "./workspace-file-hints";
import {
  analyzeEscaping,
  repairOverEscaped,
  OVER_ESCAPE_REPAIR_NOTICE,
  OVER_ESCAPE_AMBIGUOUS_ERROR,
} from "./edit-escape";
import { overlayContent } from "@/lib/agents/subagent-proposals";
import { checkFreshness, resolveReadScope } from "./file-read-log";
import {
  isAgentMemoryDisabled,
  isAgentMemoryPath,
  listMemoryNoteSizes,
  planMemoryCompaction,
} from "@/lib/agent-memory";

const logger = log.scope("edit-tools");

type EditOperation = "write" | "replace" | "merge";

interface EditFileArgs {
  path: string;
  /**
   * Undeclared aliases for `path`, accepted but not advertised in the schema.
   * Models emit these from training prior (`file_path` in Claude Code,
   * `filePath` in opencode); `resolvePathArg` canonicalises them.
   */
  file_path?: string;
  filePath?: string;
  filename?: string;
  file?: string;
  operation: EditOperation;
  description?: string;
  content?: string;
  old_content?: string;
  new_content?: string;
  /** Multi-edit: apply several old→new replaces in one call, atomically. */
  edits?: Array<{ old_content: string; new_content: string }>;
  workspace?: string;
  chatMode?: string;
  agentMode?: string;
  /**
   * Scope for the read-before-edit record (`file-read-log.ts`). Injected by the tool
   * funnel; sub-agents supply `_chatSessionId` + `_proposalSetId` instead.
   */
  _scopeSessionId?: string;
  _scopeChatId?: number;
  _chatSessionId?: number;
  workspaceId?: number;
  /**
   * Writer sub-agents only. Their edits are recorded as proposals rather than
   * written, so subsequent reads must see the proposed body — otherwise a
   * second edit to the same file matches against stale disk content and fails.
   * Threaded in by run-subagent at the tool funnel; absent for the main agent.
   */
  _proposalSetId?: string;
}

function normalizeRelativePath(input: string): string {
  return input.replace(/^\/workspace\//, "").replace(/^workspace\//, "").replace(/^\/+/, "");
}

/** Parameter names models actually emit for the target file, in precedence order. */
const PATH_ARG_ALIASES = ["path", "file_path", "filePath", "filename", "file"] as const;

/**
 * Canonicalise the target-file argument.
 *
 * `path` is our schema's name, but the rest of the ecosystem uses `file_path`
 * (Claude Code) or `filePath` (opencode), and models emit those from training
 * prior. Accepting them here is strictly better than a system-prompt clause
 * forbidding them: the prompt costs tokens every turn, still fails sometimes,
 * and produces a "missing required parameter" dead-end when it does.
 */
function resolvePathArg(rawArgs: EditFileArgs): string | undefined {
  for (const key of PATH_ARG_ALIASES) {
    const v = rawArgs[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/**
 * Enforce workspace-confinement ONLY for in-workspace targets. An explicit
 * absolute path that resolves OUTSIDE the workspace is an intentional cross-repo
 * edit — it still passes through the normal approval + diff gate downstream, so
 * we don't hard-reject it here (that's what forced sed/python shell edits before).
 */
function assertReadableUnlessOutside(
  normalizedPath: string,
  fullPath: string,
  workspaceRoot?: string,
): void {
  if (!workspaceRoot) return;
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, path.resolve(fullPath));
  const isUnderWorkspace =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (isUnderWorkspace) assertReadablePath(normalizedPath, workspaceRoot);
}

async function readFileSafe(
  fullPath: string,
  normalizedPath: string,
  operation: string,
  workspaceRoot?: string,
  proposalSetId?: string,
) {
  try {
    assertReadableUnlessOutside(normalizedPath, fullPath, workspaceRoot);
    // A writer sub-agent's own earlier edits are proposals, not bytes on disk.
    // Serve them here or its second edit to a file would match against content
    // its first edit already replaced.
    const proposed = overlayContent(proposalSetId, fullPath);
    if (proposed !== null) return { ok: true as const, content: proposed };
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
}) {
  const { normalizedPath, newContent, oldContent, description, reasoning, diff, operation, notice } = args;
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
  };
}

async function runWrite(
  args: EditFileArgs,
  normalizedPath: string,
  fullPath: string,
  workspace?: string,
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
      assertReadableUnlessOutside(normalizedPath, fullPath, workspace);
      // Same overlay rule as readFileSafe: a file this sub-agent already
      // proposed counts as existing, and its proposed body is the "old" side —
      // otherwise a second write to it reads as a fresh create.
      const proposed = overlayContent(args._proposalSetId, fullPath);
      if (proposed !== null) {
        oldContent = proposed;
        // create-vs-update still tracks DISK, not the overlay: a file this
        // sub-agent invented is a create no matter how many times it rewrites
        // its own proposal.
        fileType = fs.existsSync(fullPath) ? "update" : "create";
      } else {
        await fs.promises.access(fullPath);
        fileType = "update";
        oldContent = await fs.promises.readFile(fullPath, "utf-8");
      }
    } catch {
      fileType = "create";
    }
  }

  // Read-before-edit applies to an OVERWRITE, and only to an overwrite. A full write is
  // the most destructive operation there is — it discards everything currently in the
  // file — so it is the one that most needs the agent to have seen what it is discarding.
  // Creating a NEW file is exempt by construction: there is nothing to have read.
  if (fileType === "update" && oldContent !== undefined) {
    const staleness = freshnessError(args, normalizedPath, oldContent, "overwrite");
    if (staleness) return staleness;
  }

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
  };
}

/**
 * Human-readable name for the match strategy that actually succeeded.
 *
 * The audit notice used to hardcode "indent/EOL tolerance" for EVERY fuzzy
 * strategy. That did not merely under-inform — it actively misled: an
 * escape-normalized match was reported as an indentation problem, which sent
 * the model hunting encoding and whitespace for ~25 turns while the real cause
 * (backslash escapes written into a Go raw string) sat in plain sight. Naming
 * the strategy is the whole fix on the signalling side; `match.strategy` was
 * already returned by `findReplacement` and thrown away here.
 */
function describeMatchStrategy(strategy: string): string {
  switch (strategy) {
    case "line-trimmed":
      return "line-trimmed matching (leading/trailing whitespace ignored)";
    case "block-anchor":
      return "block-anchor matching (first and last line anchored)";
    case "whitespace":
      return "whitespace-normalized matching";
    case "indentation":
      return "indentation-tolerant matching";
    case "escape":
      return "escape-normalized matching — your old_content contained backslash escapes the file does not";
    case "unicode-punctuation":
      return "unicode-punctuation-normalized matching — the file uses typographic quotes/dashes where you sent ASCII";
    case "trimmed-boundary":
      return "boundary-trimmed matching";
    case "context-aware":
      return "context-aware matching (first/last line anchored, interior only partially matched)";
    default:
      return `${strategy} matching`;
  }
}

/** Result of applying ONE replace to an in-memory content string. */
type ApplyReplaceResult =
  | { ok: false; error: Record<string, unknown> }
  | { ok: true; content: string; notice?: string; added: number; removed: number };

/**
 * Apply a single old→new replace to `content` (in memory) via the robust match
 * cascade, with escape-repair + fuzzy re-indent. Pure — returns the new content
 * or a structured error; the caller decides whether to write (so a multi-edit
 * set stays atomic: nothing is written if any edit fails).
 */
/**
 * Refuse an edit that would work from a view the agent doesn't actually hold.
 *
 * Returns a structured tool error, or null when the edit may proceed. Both messages name
 * the exact next action — a gate that only says "no" costs a turn and teaches nothing.
 *
 * `retry.reason` lets the harness distinguish these from a genuine content mismatch, and
 * `fail_open` (no scope resolvable) is deliberate: see `checkFreshness`.
 */
function freshnessError(
  args: EditFileArgs,
  normalizedPath: string,
  currentContent: string,
  kind: "edit" | "overwrite" = "edit",
): { error: string; operation: "edit_file"; retry: { reason: string; guidance: string } } | null {
  const scope = resolveReadScope(args);
  const verdict = checkFreshness(scope, normalizedPath, currentContent);
  if (verdict.ok) return null;
  const action = kind === "overwrite" ? "overwriting" : "editing";
  if (verdict.reason === "never_read") {
    return {
      error:
        `Read ${normalizedPath} before ${action} it — call read_file first, then retry this edit. ` +
        `Editing a file you have not read is how the wrong region gets changed.`,
      operation: "edit_file",
      retry: { reason: "not_read", guidance: `read_file ${normalizedPath}, then retry` },
    };
  }
  return {
    error:
      `${normalizedPath} has changed since you last read it, so your view of it is out of date. ` +
      `Re-read it with read_file and retry against the current content.`,
    operation: "edit_file",
    retry: { reason: "stale_read", guidance: `re-read ${normalizedPath}, then retry` },
  };
}

function applyOneReplace(
  content: string,
  oldRaw: string,
  newRaw: string,
  normalizedPath: string,
): ApplyReplaceResult {
  // §B: repair over-escaped new_content before it splices in; hard-block
  // ambiguous partial over-escaping rather than corrupt the file.
  const newEscapeVerdict = analyzeEscaping(newRaw);
  if (newEscapeVerdict === "ambiguous") {
    return { ok: false, error: { error: OVER_ESCAPE_AMBIGUOUS_ERROR, operation: "edit_file" } };
  }
  const effectiveNew = newEscapeVerdict === "repair" ? repairOverEscaped(newRaw) : newRaw;
  const escapeNotice = newEscapeVerdict === "repair" ? OVER_ESCAPE_REPAIR_NOTICE : undefined;

  // §D: robust match cascade — a near-miss self-heals instead of erroring, with
  // uniqueness + disproportion rails so we never edit the wrong region.
  const match = findReplacement(content, oldRaw);

  if (match.kind === "none") {
    const lines = content.split("\n");
    const firstLineOfOld = oldRaw.split("\n")[0].trim();
    const similarLine = lines.findIndex((l) => l.includes(firstLineOfOld.slice(0, 30)));
    let hint = "";
    let nearMiss: { line: number; preview: string } | undefined;
    if (similarLine !== -1) {
      const from = Math.max(0, similarLine - 2);
      const to = Math.min(lines.length, similarLine + 3);
      nearMiss = { line: similarLine + 1, preview: lines.slice(from, to).join("\n") };
      // No "the file changed since you read it" claim here any more. The read-before-edit
      // gate above has already established that the agent's view IS current, so reaching
      // this point means `old_content` simply doesn't match what is really in the file —
      // saying anything about the file having changed would be the wrong explanation, and
      // acting on the wrong explanation is what made a model conclude the user had
      // already applied its fix.
      hint = `\n\nClosest candidate at line ${similarLine + 1}:\n---\n${nearMiss.preview}\n---\nYour old_content does not match the file. Compare it against the candidate above and retry with the EXACT current content (read_file start_line=${from + 1}, end_line=${to} to see more).`;
    } else {
      hint =
        "\n\nNo similar content found anywhere in the file — old_content may belong to a different file, or the symbol may have been renamed. Search for it (grep) before retrying.";
    }
    return {
      ok: false,
      error: {
        error: `Content to replace not found in ${normalizedPath}. old_content must match exactly (whitespace included).${hint}`,
        operation: "edit_file",
        retry: {
          reason: "no_match",
          ...(nearMiss ? { nearMiss } : {}),
          guidance: "re-read the target range, then retry with exact content",
        },
      },
    };
  }
  if (match.kind === "multiple") {
    return {
      ok: false,
      error: {
        error: `Found ${match.occurrences} occurrences of old_content in ${normalizedPath}. Provide more surrounding context to make the match unique.`,
        operation: "edit_file",
      },
    };
  }
  if (match.kind === "disproportionate") {
    return {
      ok: false,
      error: {
        error: `Refusing this replace: the closest match in ${normalizedPath} spans far more than old_content, so applying it would likely clobber the wrong region. Re-read the target and pass the exact, complete old_content.`,
        operation: "edit_file",
        retry: { reason: "disproportionate_match", guidance: "re-read and pass exact old_content" },
      },
    };
  }

  // §1.4: fuzzy drift is not silent — re-anchor to the file's ACTUAL indentation
  // and surface a notice so the edited range gets re-verified.
  //
  // SYMMETRY RULE: whichever normalization let the match succeed must ALSO be
  // applied to the replacement. The cascade is lenient on the find side, so
  // splicing new_content verbatim writes back whatever malformation permitted
  // the match in the first place. `reindentReplacement` is this rule for the
  // whitespace replacers; `escape` needed it too and did not have it — observed
  // live writing a model's `\"` into a Go raw string literal (which cannot
  // contain escapes) and breaking the build, because reindentReplacement
  // deliberately short-circuits on escape fuzz (edit-match.ts:505-514) so
  // nothing touched the backslashes.
  //
  // `unicode-punctuation` is deliberately NOT transformed: re-curling quotes
  // cannot be done safely (opening vs closing is unrecoverable), so it carries
  // a caveat instead of a repair.
  let fuzzyNotice: string | undefined;
  let effectiveReplacement = effectiveNew;
  if (match.fuzzy) {
    const matchLine = content.slice(0, match.index).split("\n").length;
    const matchedText = content.slice(match.index, match.index + match.matchLength);
    const notes: string[] = [];

    // The find side was un-escaped to locate the region, so un-escape the write
    // side by the same rule. old_content is un-escaped too, so the re-indent
    // pass below compares like with like rather than escaped-vs-unescaped text.
    let oldForIndent = oldRaw;
    if (match.strategy === "escape") {
      const unescaped = unescapeString(effectiveReplacement);
      if (unescaped !== effectiveReplacement) {
        effectiveReplacement = unescaped;
        notes.push(
          "new_content was un-escaped the same way old_content was, so the file did not receive literal backslash escapes",
        );
      }
      oldForIndent = unescapeString(oldRaw);
    }

    if (match.strategy === "unicode-punctuation") {
      notes.push(
        "new_content is written exactly as you sent it, so the replaced span now uses your ASCII punctuation where the rest of the file uses typographic characters",
      );
    }

    const reindented = reindentReplacement(matchedText, oldForIndent, effectiveReplacement);
    if (reindented.changed) {
      effectiveReplacement = reindented.text;
      notes.push("new_content was re-anchored to the file's actual indentation");
    }

    fuzzyNotice =
      `Applied via ${describeMatchStrategy(match.strategy)}, at line ${matchLine}` +
      (notes.length ? ` — ${notes.join("; ")}` : "") +
      `. Re-read the edited range to verify.`;
    logger.warn(
      `[edit_file] fuzzy match strategy=${match.strategy}${
        notes.length ? ` notes=${notes.length}` : ""
      } for ${normalizedPath} at line ${matchLine}`,
    );
  }

  const notice = [fuzzyNotice, escapeNotice].filter(Boolean).join(" ") || undefined;
  const newContent =
    content.slice(0, match.index) +
    effectiveReplacement +
    content.slice(match.index + match.matchLength);
  return {
    ok: true,
    content: newContent,
    ...(notice ? { notice } : {}),
    added: effectiveReplacement.split("\n").length,
    removed: oldRaw.split("\n").length,
  };
}

async function runReplace(
  args: EditFileArgs,
  normalizedPath: string,
  fullPath: string,
  workspace?: string,
) {
  const { description } = args;
  // Multi-edit: an `edits` array applies several replaces in one call, atomically
  // (nothing is written if ANY fails). Falls back to the single old/new fields.
  const edits =
    Array.isArray(args.edits) && args.edits.length > 0
      ? args.edits
      : args.old_content != null && args.new_content !== undefined
        ? [{ old_content: args.old_content, new_content: args.new_content }]
        : null;
  if (!edits) {
    return {
      error:
        "operation=replace requires old_content + new_content, or an edits array of {old_content, new_content}",
      operation: "edit_file",
    };
  }
  for (const e of edits) {
    if (!e.old_content || e.new_content === undefined) {
      return { error: "each edit needs old_content and new_content", operation: "edit_file" };
    }
  }

  const r = await readFileSafe(fullPath, normalizedPath, "edit_file", workspace, args._proposalSetId);
  if (!r.ok) return r.error;

  let content = r.content;
  const notices: string[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  for (let i = 0; i < edits.length; i++) {
    const res = applyOneReplace(content, edits[i].old_content, edits[i].new_content, normalizedPath);
    if (!res.ok) {
      // Atomic: abort the whole set — nothing is written.
      if (edits.length > 1) {
        res.error.error = `Edit ${i + 1} of ${edits.length} failed — no changes applied. ${String(res.error.error ?? "")}`;
      }
      return res.error;
    }
    content = res.content;
    if (res.notice) notices.push(res.notice);
    totalAdded += res.added;
    totalRemoved += res.removed;
  }

  const notice = notices.length ? notices.join(" ") : undefined;
  const label = edits.length > 1 ? `${edits.length} edits` : "Surgical replace";
  return permissionPayload({
    normalizedPath,
    newContent: content,
    oldContent: r.content,
    description: notice ? `${description ?? label} (${notice})` : (description ?? label),
    ...(notice ? { notice } : {}),
    operation: "edit_file",
    diff: {
      removed: totalRemoved,
      added: totalAdded,
      old_snippet:
        edits[0].old_content.slice(0, 200) + (edits[0].old_content.length > 200 ? "..." : ""),
      new_snippet:
        edits[0].new_content.slice(0, 200) + (edits[0].new_content.length > 200 ? "..." : ""),
    },
    reasoning: `Replace in ${normalizedPath}: ${description ?? "(no description)"} (${edits.length} edit${edits.length > 1 ? "s" : ""})`,
  });
}

/**
 * Elision-merge: the model provides the file's new shape with unchanged spans
 * collapsed to `// ... existing code ...` markers, so it never has to reproduce
 * exact old text. We stitch it into the real file deterministically (edit-merge)
 * and refuse (rather than corrupt) if a marker can't be anchored.
 */
async function runMerge(
  args: EditFileArgs,
  normalizedPath: string,
  fullPath: string,
  workspace?: string,
) {
  const { content, description } = args;
  if (content === undefined || content === "") {
    return {
      error:
        "operation=merge requires content: the file's new form with '// ... existing code ...' markers where spans are unchanged. Keep the lines adjacent to each marker copied verbatim from the file.",
      operation: "edit_file",
    };
  }
  const escapeVerdict = analyzeEscaping(content);
  if (escapeVerdict === "ambiguous") {
    return { error: OVER_ESCAPE_AMBIGUOUS_ERROR, operation: "edit_file" };
  }
  const effective = escapeVerdict === "repair" ? repairOverEscaped(content) : content;
  const escapeNotice = escapeVerdict === "repair" ? OVER_ESCAPE_REPAIR_NOTICE : undefined;

  const r = await readFileSafe(fullPath, normalizedPath, "edit_file", workspace, args._proposalSetId);
  if (!r.ok) return r.error;

  const merged = mergeElision(r.content, effective);
  if (!merged.ok) {
    return {
      error: merged.error,
      operation: "edit_file",
      retry: {
        reason: "merge_anchor_failed",
        guidance:
          "keep the lines right before/after each marker unchanged, or use operation=replace for a surgical edit",
      },
    };
  }

  // Accurate +/- for the card: trim the common head/tail, the middle is the change.
  const oldL = r.content.split("\n");
  const newL = merged.merged.split("\n");
  let p = 0;
  while (p < oldL.length && p < newL.length && oldL[p] === newL[p]) p++;
  let sfx = 0;
  while (
    sfx < oldL.length - p &&
    sfx < newL.length - p &&
    oldL[oldL.length - 1 - sfx] === newL[newL.length - 1 - sfx]
  )
    sfx++;

  const notice =
    [
      merged.fullRewrite ? undefined : "Merged via elision markers — re-read the file to verify.",
      escapeNotice,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return permissionPayload({
    normalizedPath,
    newContent: merged.merged,
    oldContent: r.content,
    description: description ?? (merged.fullRewrite ? "Rewrite file" : "Merge edit"),
    ...(notice ? { notice } : {}),
    operation: "edit_file",
    diff: {
      removed: Math.max(0, oldL.length - p - sfx),
      added: Math.max(0, newL.length - p - sfx),
      old_snippet: "",
      new_snippet: "",
    },
    reasoning: `Merge into ${normalizedPath}: ${description ?? "(no description)"}`,
  });
}

ToolRegistry.register({
  name: "edit_file",
  // CONTRACT + PRECONDITIONS ONLY. The failure taxonomy that used to live here is
  // delivered by the result channel instead — `applyOneReplace` returns the actual
  // near-miss with its line numbers, the exact read_file(start_line, end_line) to
  // retry from, and a structured `retry` reason. Preconditions are prospective and
  // must arrive before the call; failures are retrospective and are better told
  // with the real file in hand.
  description: `Create, overwrite, or surgically edit a file — the single tool for all file changes.
- replace: find \`old_content\` and swap it for \`new_content\`. Pass an \`edits\` array to make SEVERAL replaces in ONE atomic call. This is the default choice for an existing file.
- write: create a NEW file, or fully overwrite one, with \`content\`. Keep a single write to ≲800 lines — split a larger file across calls, or the write is truncated.
- merge: give the file's new shape in \`content\` with \`// ... existing code ...\` where spans are unchanged, keeping the lines either side of each marker verbatim. Use it when reproducing the surrounding text exactly would be error-prone.

Read the file first — \`replace\` matches its current bytes, and you'll be told exactly what didn't match and where. Use real newlines and real quotes in content/new_content, never backslash-escaped ones. Never describe an edit instead of making it.`,
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "File to edit. A relative path resolves against the workspace root; to edit a file outside the workspace, give its ABSOLUTE path (you will be asked once to grant that folder).",
      },
      operation: {
        type: "string",
        enum: ["write", "replace", "merge"],
        description:
          "\"replace\" for a surgical change to an EXISTING file (the default choice); \"merge\" for a larger edit using '... existing code ...' markers; \"write\" only to CREATE a new file or fully rewrite one.",
      },
      description: { type: "string", description: "Brief description of what this edit does." },
      content: {
        type: "string",
        description: "(write) Full file body to create or overwrite. (merge) The file's new form with '// ... existing code ...' markers for unchanged spans. Use real newlines.",
      },
      old_content: {
        type: "string",
        description: "(replace) Content to find and replace. Include enough surrounding context to match one unique spot; minor indentation/whitespace drift is tolerated.",
      },
      new_content: {
        type: "string",
        description: "(replace) Replacement content. Required for operation=replace. Use real newlines.",
      },
      edits: {
        type: "array",
        description:
          "(replace) OPTIONAL — apply SEVERAL edits to the file in ONE call instead of one round-trip each. Each item is {old_content, new_content}; they apply top-to-bottom and are ATOMIC (if any old_content doesn't match, NOTHING is written and you get told which edit failed). Use this instead of many separate replace calls.",
        items: {
          type: "object",
          properties: {
            old_content: { type: "string", description: "Content to find (unique context)." },
            new_content: { type: "string", description: "Replacement content." },
          },
          required: ["old_content", "new_content"],
        },
      },
    },
    required: ["path", "operation"],
  },
  handler: async (rawArgs: EditFileArgs) => {
    const { operation, workspace, chatMode } = rawArgs;
    // Absorb the mistake instead of prompting against it. Every other agent
    // harness names this parameter `file_path` (Claude Code's Read/Edit/Write,
    // opencode's read/write), so models reach for it by training prior and the
    // call failed as a missing required parameter. A prompt clause forbidding it
    // cost tokens on every turn and still missed; an alias never misses.
    const filePath = resolvePathArg(rawArgs);

    if (chatMode === "ask") {
      return { error: "Edit operations not allowed in Ask mode. Switch to Build mode.", operation: "edit_file", denied: true };
    }

    // Plan mode cannot edit files AT ALL. `edit_file` is absent from
    // PLAN_ALLOWLIST, so native function calling can never reach here — but the
    // text-tool fallback (build-branch.ts) dispatches by NAME through
    // ToolRegistry with no allowlist check, which is the path this backstop
    // exists for (see mode-tool-registry.ts:79-82).
    //
    // The former `.atlarix`-docs carve-out is gone: it advertised a capability
    // the allowlist never granted, so the two prompt claims describing it were
    // simply false. Plan authors its artifact through the `plan` tool.
    if (chatMode === "plan") {
      return {
        error:
          "Edit operations not allowed in Plan mode. Use the plan tool for the session plan; switch to Build or Debug to change files.",
        operation: "edit_file",
        denied: true,
      };
    }

    if (!filePath) return { error: "Missing required parameter: path", operation: "edit_file" };
    if (!operation) return { error: "Missing required parameter: operation", operation: "edit_file" };

    // An EXPLICIT target — an absolute path, or a relative one written with `../`
    // — addresses that exact location (cross-repo edits); it's still gated by the
    // approval + diff downstream, and an outside path additionally raises the
    // folder-grant prompt in the interceptor. An ordinary relative path stays
    // confined under the workspace exactly as before.
    //
    // Absolute is the canonical spelling for anything outside the workspace and is
    // what the prompt teaches; `../` is ABSORBED rather than rejected. Rejecting it
    // here while accepting the byte-identical absolute path was a spelling rule
    // masquerading as a boundary — and it read to the model as "you may not leave
    // the workspace", which sent it to shell `sed`/`python` instead. Same condition
    // as read_file/glob/grep, so all four file tools resolve identically.
    const rawFilePath = String(filePath).trim();
    const isExplicitTarget =
      path.isAbsolute(rawFilePath) ||
      /^\.\.[\\/]/.test(rawFilePath) ||
      rawFilePath === "..";
    const absoluteTarget =
      isExplicitTarget && workspace
        ? resolveToolTargetPath(workspace, filePath)
        : null;
    const normalizedPath = absoluteTarget
      ? absoluteTarget.absPath
      : normalizeRelativePath(filePath);

    const fullPath = absoluteTarget
      ? absoluteTarget.absPath
      : workspace
        ? path.join(workspace, normalizedPath)
        : path.resolve(normalizedPath);
    assertReadableUnlessOutside(normalizedPath, fullPath, workspace);

    const result = await (async () => {
      switch (operation) {
        case "write":
          return runWrite(rawArgs, normalizedPath, fullPath, workspace);
        case "replace":
          return runReplace(rawArgs, normalizedPath, fullPath, workspace);
        case "merge":
          return runMerge(rawArgs, normalizedPath, fullPath, workspace);
        default:
          return { error: `Unknown operation: ${operation}. Use write | replace | merge.`, operation: "edit_file" };
      }
    })();

    // Agent-memory compaction directive, computed from the FINAL body every operation
    // produces.
    //
    // Applied here rather than inside each operation because all three converge on one
    // envelope shape (`preview.content` is the exact bytes that will land), so one place
    // covers write / replace / merge — including a sub-agent proposal, which reaches
    // disk through this same tool.
    //
    // Nothing is ever REFUSED for size. Memory compacts like context does: the write
    // lands and the agent is told which notes to rewrite for accuracy.
    return await annotateAgentMemoryCompaction(result, fullPath, workspace);
  },
});

/**
 * Attach a compaction directive to an edit_file envelope whose target is an
 * agent-memory note, once the store is large enough to need one.
 *
 * Never refuses and never alters the write. Non-memory paths and non-envelope results
 * pass through untouched, so this cannot affect ordinary editing.
 */
async function annotateAgentMemoryCompaction(
  result: unknown,
  fullPath: string,
  workspace?: string,
): Promise<unknown> {
  if (!workspace || isAgentMemoryDisabled()) return result;
  const envelope = result as
    | { __permission_required?: boolean; preview?: { content?: string; notice?: string } }
    | undefined;
  const content = envelope?.preview?.content;
  if (!envelope?.__permission_required || typeof content !== "string") return result;
  if (!isAgentMemoryPath(workspace, fullPath)) return result;

  const noteName = path.basename(fullPath);
  const plan = planMemoryCompaction({
    notes: await listMemoryNoteSizes(workspace),
    // The note about to land, so a rewrite that shrinks it counts as progress on this
    // very call rather than one write later.
    pendingWrite: { name: noteName, bytes: Buffer.byteLength(content, "utf8") },
  });
  if (!plan) return result;

  if (plan.required) {
    logger.log(
      `[edit_file] memory compaction required for this workspace (${plan.totalBytes}B)`,
    );
  }
  // Rides the existing `notice` field — the one the approval card and the model already
  // both read — rather than inventing a second signalling channel.
  //
  // One line, not a paragraph: the agent is already inside the memory store on this
  // call, so it needs the state and the file names, not a re-teaching of the convention
  // (which is one `guides/memory` read away and only worth reading when acting on it).
  const notice = `Project memory ${plan.flag}.`;
  return {
    ...envelope,
    preview: {
      ...envelope.preview,
      notice: envelope.preview?.notice
        ? `${envelope.preview.notice}\n\n${notice}`
        : notice,
    },
  };
}
