/**
 * Read-before-edit freshness, per session.
 * =======================================
 *
 * WHAT IT ENFORCES
 * ----------------
 * `edit_file` may only touch a file the agent has READ in this session, and only while
 * what it read still matches what it is about to edit. Two rules, one record:
 *
 *   - never read     → "read_file <path> first"
 *   - read went stale → "<path> has changed since you last read it — re-read it"
 *
 * WHY THIS SHAPE (and not the one it replaced)
 * --------------------------------------------
 * The previous attempt tried to answer "whose change was this?" so the error could say
 * "you edited it" vs "someone else did". That was the wrong question. It needed
 * authorship bookkeeping the harness had no reliable way to key (the funnel never
 * injected a chat id into `edit_file`, so it silently never fired), and it only improved
 * an error message AFTER a stale edit had already been attempted.
 *
 * A freshness gate removes the question. Nobody has to know who changed the file,
 * because an edit can't proceed from a stale view in the first place — which is also
 * what stops the failure that motivated it: a model that read its own out-of-date
 * mental model of a file, concluded the work was already done, and acted on that.
 *
 * WHY IT HASHES WHAT THE READ RETURNED, NOT DISK
 * ----------------------------------------------
 * Sub-agents don't read disk. `run-subagent.ts` passes `_proposalSetId` so their
 * `read_file`/`edit_file` see the run's proposal OVERLAY — their own uncommitted edits.
 * Hashing disk would report every sub-agent edit as stale. Hashing the bytes the read
 * actually served makes main-agent and sub-agent behave identically with no special case.
 */

import { createHash } from "node:crypto";

/** Content fingerprint. Content, not mtime — mtime moves without the bytes changing. */
function hashContent(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex");
}

function pathKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/** scopeKey → (pathKey → content hash last seen by THAT scope). */
const readsByScope = new Map<string, Map<string, string>>();

export interface ReadScopeArgs {
  /**
   * Writer sub-agent's proposal set. Preferred when present so a sub-agent's reads are
   * its OWN — the parent having read a file must not satisfy the sub-agent's gate, since
   * the sub-agent hasn't seen it and edits against a different (overlay) view.
   */
  _proposalSetId?: string;
  /** Workspace session UUID — stable across app relaunches, unlike a transport chat id. */
  _scopeSessionId?: string;
  _scopeChatId?: number;
  /** What sub-agents pass. */
  _chatSessionId?: number;
}

/**
 * The record this call belongs to, or null when nothing identifies it.
 *
 * Null means the gate cannot make a judgement and callers must FAIL OPEN — a headless
 * or synthetic path with no scope must not become unable to edit.
 */
export function resolveReadScope(args: ReadScopeArgs): string | null {
  if (args._proposalSetId) return `prop:${args._proposalSetId}`;
  if (args._scopeSessionId) return `sess:${args._scopeSessionId}`;
  const chatId = args._scopeChatId ?? args._chatSessionId;
  return chatId != null ? `chat:${chatId}` : null;
}

/** Remember the bytes a read served. Called on every successful `read_file`. */
export function recordFileRead(
  scope: string | null,
  filePath: string,
  content: string,
): void {
  if (!scope || !filePath?.trim()) return;
  let m = readsByScope.get(scope);
  if (!m) {
    m = new Map<string, string>();
    readsByScope.set(scope, m);
  }
  m.set(pathKey(filePath), hashContent(content));
}

/**
 * Refresh after a WRITE lands, so consecutive edits don't need a re-read between them.
 *
 * This is what keeps the gate from being punitive: having just written a file, the agent
 * knows its contents exactly. Without this, every edit in a multi-step change would
 * demand a re-read of a file the agent itself had just authored.
 */
export function recordFileWrite(
  scope: string | null,
  filePath: string,
  newContent: string,
): void {
  recordFileRead(scope, filePath, newContent);
}

export type FreshnessVerdict =
  | { ok: true }
  | { ok: false; reason: "never_read" }
  | { ok: false; reason: "stale" };

/**
 * Whether `content` (the bytes the edit is about to operate on) matches what this scope
 * last read.
 *
 * Fails OPEN when there is no scope: an un-scoped caller is a harness gap, and refusing
 * every edit would be a far worse failure than allowing an unverified one.
 */
export function checkFreshness(
  scope: string | null,
  filePath: string,
  content: string,
): FreshnessVerdict {
  if (!scope) return { ok: true };
  const seen = readsByScope.get(scope)?.get(pathKey(filePath));
  if (seen === undefined) return { ok: false, reason: "never_read" };
  return seen === hashContent(content)
    ? { ok: true }
    : { ok: false, reason: "stale" };
}

/** Drop a scope's records (session delete, or a finished sub-agent run). */
export function clearReadScope(scope: string | null): void {
  if (scope) readsByScope.delete(scope);
}

/** Test seam. */
export function __clearAllReadScopes(): void {
  readsByScope.clear();
}
