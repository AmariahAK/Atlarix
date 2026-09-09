/**
 * Writer sub-agent edit proposals — the in-memory replacement for the throwaway
 * git worktree (v14.21.0).
 *
 * The worktree existed for one reason: `edit_file` never writes. It returns a
 * `__permission_required` envelope whose `preview.content` is the full resolved
 * file body, and the MAIN chat's approval interceptor is what lands it. A
 * sub-agent runs without that interceptor, so its proposals evaporated — the
 * worktree was somewhere to put them so a diff could be captured.
 *
 * But the proposal already IS the artifact. So we keep it here instead: a
 * per-run overlay of {path -> proposed body}, which
 *
 *   - lets the sub-agent see its OWN edits on re-read (what the worktree gave
 *     for free, and the reason a naive "just don't write" approach breaks the
 *     moment a sub-agent edits one file twice), and
 *   - hands the main agent a set of real before/after bodies to review, rather
 *     than 20K characters of truncated markdown diff.
 *
 * `grep`/`glob` deliberately do NOT consult the overlay — they hit disk. The
 * writer prompt says so, because a sub-agent searching for text it has only
 * proposed would otherwise get confusing misses.
 *
 * Nothing here touches disk except the one read that captures `baseContent`.
 */

import * as fs from "fs";
import { recordFileWrite, resolveReadScope } from "@/lib/tools/file-read-log";
import * as path from "path";
import log from "electron-log";

const logger = log.scope("subagent-proposals");

/**
 * Per-file memory caps. A proposal set lives in the MAIN process for the life
 * of a sub-agent run plus its review, so an unbounded set is a main-process
 * memory leak that outlives the turn. These are deliberately generous — they
 * exist to stop a runaway loop, not to constrain real edits.
 */
const MAX_PROPOSED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROPOSAL_SET_BYTES = 20 * 1024 * 1024;

export interface ProposedFile {
  /** Display path — workspace-relative when inside it, absolute for cross-repo. */
  relPath: string;
  /** Absolute resolved path; the overlay key. */
  fullPath: string;
  /**
   * Disk content at FIRST touch, or null when the sub-agent created the file.
   * This is the merge base: at accept time we compare it against disk to detect
   * that the file moved under the proposal. It is NEVER refreshed on later
   * edits, or a concurrent change would be silently adopted as the base.
   */
  baseContent: string | null;
  /** Latest proposed body. Overwritten by each subsequent edit. */
  content: string;
  type: "create" | "update";
  /** How many edits the sub-agent made to this file. Diagnostics only. */
  edits: number;
}

export interface ProposalSet {
  id: string;
  chatId: number;
  taskId: string;
  /** The sub-agent's short description — how the main agent addresses it. */
  agentName: string;
  workspace: string;
  files: Map<string, ProposedFile>;
  /** Set when the sub-agent finishes; a closed set accepts no further edits. */
  closed: boolean;
}

const sets = new Map<string, ProposalSet>();

let seq = 0;

export function createProposalSet(args: {
  chatId: number;
  taskId: string;
  agentName: string;
  workspace: string;
}): string {
  seq += 1;
  const id = `prop_${args.taskId}_${seq}`;
  sets.set(id, {
    id,
    chatId: args.chatId,
    taskId: args.taskId,
    agentName: args.agentName,
    workspace: args.workspace,
    files: new Map(),
    closed: false,
  });
  return id;
}

export function getProposalSet(
  id: string | undefined | null,
): ProposalSet | null {
  if (!id) return null;
  return sets.get(id) ?? null;
}

export function closeProposalSet(id: string): ProposalSet | null {
  const set = sets.get(id);
  if (!set) return null;
  set.closed = true;
  return set;
}

export function deleteProposalSet(id: string): void {
  sets.delete(id);
}

/** Every set still held for this chat — live or awaiting review. */
export function listProposalSetsForChat(chatId: number): ProposalSet[] {
  return [...sets.values()].filter((s) => s.chatId === chatId);
}

/**
 * Drop everything for a chat. Called when a turn is cancelled or a session
 * closes: an unreviewed proposal has no meaning once its conversation is gone,
 * and holding file bodies for a dead chat is just a leak.
 */
export function dropProposalSetsForChat(chatId: number): number {
  let dropped = 0;
  for (const [id, s] of sets) {
    if (s.chatId === chatId) {
      sets.delete(id);
      dropped += 1;
    }
  }
  return dropped;
}

/** Test-only reset. */
export function __clearAllProposalSets(): void {
  sets.clear();
  seq = 0;
}

function setBytes(set: ProposalSet): number {
  let total = 0;
  for (const f of set.files.values())
    total += Buffer.byteLength(f.content, "utf8");
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay reads — what makes a sub-agent see its own unwritten edits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The proposed body for `fullPath`, or null when this set hasn't touched it
 * (in which case the caller reads disk as normal).
 */
export function overlayContent(
  setId: string | undefined | null,
  fullPath: string,
): string | null {
  const set = getProposalSet(setId);
  if (!set) return null;
  return set.files.get(path.resolve(fullPath))?.content ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture
// ─────────────────────────────────────────────────────────────────────────────

interface EditPermissionEnvelope {
  __permission_required?: boolean;
  operation?: string;
  preview?: {
    path?: string;
    content?: string;
    oldContent?: string;
    type?: "create" | "update";
  };
}

export interface RecordedProposal {
  relPath: string;
  type: "create" | "update";
  lines: number;
  /**
   * The proposed body. Exposed so the caller can refresh the read-before-edit record —
   * this IS the sub-agent's new view of the file (the overlay serves it on the next
   * read), so without it the sub-agent's own second edit reads as stale.
   */
  content: string;
}

/**
 * Fold an `edit_file` permission envelope into the set instead of writing it.
 *
 * Returns null when `result` isn't an edit proposal (an error result, a
 * different tool) so the caller can pass it through untouched. Throws only on a
 * cap breach, which the caller turns into a tool error the sub-agent can read.
 */
/**
 * A recorded proposal IS this sub-agent's new view of the file — `overlayContent` serves
 * it on the next read. Refresh the read-before-edit record to match, or the sub-agent's
 * OWN second edit reads as stale: the overlay returns the proposed body while the record
 * still holds the pre-edit hash. Lives here rather than at the call site because this is
 * the choke point every proposal path goes through.
 */
function refreshProposalReadRecord(
  setId: string | undefined | null,
  relPath: string,
  content: string,
): void {
  if (!setId) return;
  recordFileWrite(
    resolveReadScope({ _proposalSetId: setId }),
    relPath,
    content,
  );
}

export function recordEditProposal(
  setId: string | undefined | null,
  result: unknown,
): RecordedProposal | null {
  const set = getProposalSet(setId);
  if (!set) return null;
  if (set.closed) {
    throw new Error(
      "This sub-agent's proposal set is already closed — its run has finished.",
    );
  }

  const env = result as EditPermissionEnvelope;
  if (!env || typeof env !== "object") return null;
  if (env.__permission_required !== true) return null;
  if (env.operation !== "edit_file") return null;

  const rel = env.preview?.path;
  const content = env.preview?.content;
  if (typeof rel !== "string" || !rel || typeof content !== "string")
    return null;

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_PROPOSED_FILE_BYTES) {
    throw new Error(
      `Proposed body for ${rel} is ${Math.round(bytes / 1024)}KB, over the ` +
        `${Math.round(MAX_PROPOSED_FILE_BYTES / 1024)}KB per-file limit for a sub-agent proposal. ` +
        "Make a smaller, surgical edit.",
    );
  }

  const fullPath = path.isAbsolute(rel)
    ? path.resolve(rel)
    : path.resolve(set.workspace, rel);

  const existing = set.files.get(fullPath);
  if (existing) {
    // Second and later edits to the same file: replace the body, KEEP the
    // original base and type. `preview.oldContent` here is the overlay's own
    // previous content (readFileSafe served it), so adopting it as the base
    // would quietly erase the real pre-run state we need at accept time.
    const projected =
      setBytes(set) - Buffer.byteLength(existing.content, "utf8") + bytes;
    if (projected > MAX_PROPOSAL_SET_BYTES) {
      throw new Error(
        `This sub-agent's proposed changes exceed ${Math.round(MAX_PROPOSAL_SET_BYTES / 1024 / 1024)}MB in total. Narrow the scope.`,
      );
    }
    existing.content = content;
    existing.edits += 1;
    refreshProposalReadRecord(setId, existing.relPath, content);
    return {
      relPath: existing.relPath,
      type: existing.type,
      lines: content.split("\n").length,
      content,
    };
  }

  if (setBytes(set) + bytes > MAX_PROPOSAL_SET_BYTES) {
    throw new Error(
      `This sub-agent's proposed changes exceed ${Math.round(MAX_PROPOSAL_SET_BYTES / 1024 / 1024)}MB in total. Narrow the scope.`,
    );
  }

  // First touch. `oldContent` is present whenever the file existed on disk, so
  // it IS the base — no extra read needed. Absent means a create.
  const oldContent = env.preview?.oldContent;
  const baseContent = typeof oldContent === "string" ? oldContent : null;
  const type: "create" | "update" =
    env.preview?.type === "create" || baseContent === null
      ? "create"
      : "update";

  set.files.set(fullPath, {
    relPath: rel,
    fullPath,
    baseContent,
    content,
    type,
    edits: 1,
  });

  logger.info(
    `[proposals] ${set.agentName}: recorded ${type} for ${rel} (${content.split("\n").length} lines)`,
  );

  refreshProposalReadRecord(setId, rel, content);
  return { relPath: rel, type, lines: content.split("\n").length, content };
}

/**
 * Re-read a proposed file's CURRENT disk content, for the staleness check at
 * accept time. Returns null when the file no longer exists (deleted under us).
 */
export async function readCurrentDiskContent(
  fullPath: string,
): Promise<string | null> {
  try {
    return await fs.promises.readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}
