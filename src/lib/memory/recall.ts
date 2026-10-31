/**
 * Memory recall — which project notes bear on the user's next message.
 *
 * The index alone (shown once per session) leaves the agent to decide which note
 * to open, and it mostly doesn't. So on each user message a small side call reads
 * the notes' DESCRIPTIONS — never their bodies — and names up to five; the turn
 * then carries those notes as background (`session-context.ts`).
 *
 * The call uses the session-title model (`resolveTitleModel`): Core/Auto routes it
 * as `purpose:"memory"`, BYOK uses the provider's small sibling, and a BYOK prompt
 * never falls back to Core. It is billed like any other request. It is never
 * allowed to hold a turn up: one attempt, a short timeout, and any failure is
 * simply "nothing recalled".
 */

import log from "electron-log";
import type { LargeLanguageModel } from "@/lib/schemas";

const logger = log.scope("memory-recall");

/** At most this many notes are attached to one message. */
export const RECALL_MAX_NOTES = 5;
/**
 * How long the selector model may take. The reply is a short JSON list, so a
 * healthy model answers in well under this; anything slower is usually the
 * overload that the local fallback below exists for. Kept short so a failing
 * recall does not hold the turn for the old 8 s on every message.
 */
const RECALL_TIMEOUT_MS = 2_500;
/** Runaway insurance only — the reply is a short JSON list. */
const RECALL_MAX_OUTPUT_TOKENS = 512;
/** The message as the selector sees it; the head carries the intent. */
const RECALL_MESSAGE_CHARS = 4_000;

export type RecallCandidate = {
  /** Note file name inside the memory directory. */
  file: string;
  description: string;
  type?: string;
  ageDays: number;
};

export const RECALL_SYSTEM_PROMPT = `You pick which of a project's memory notes an AI coding agent should have in front of it for the user's next message. You get the message and the notes, each as its file name, type, age and description.
Reply with JSON only, in the form {"files": ["<file>", ...]}: at most ${RECALL_MAX_NOTES} files, only notes clearly useful for THIS message, fewest first. Reply {"files": []} when none are.`;

export function ageLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/** Words that never identify a note in the local fallback scorer. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "what", "when",
  "where", "which", "will", "have", "has", "was", "are", "not", "but", "all",
  "can", "how", "get", "its", "also", "just", "out", "into", "about", "over",
  "then", "now", "our", "you", "them", "been", "more", "than", "some", "any",
  "each", "other", "there", "here", "should", "would", "could", "their", "they",
  "being", "does", "did", "doing", "very", "because", "before", "after", "make",
]);

/** Lowercase alphanumeric tokens; stop words and 1-char fragments are dropped. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Deterministic, free recall: score each candidate's file name and description
 * against the message's tokens and return the best few. Used when the selector
 * model is unreachable (overloaded / rate-limited / timed out) so a message
 * still carries the notes that obviously bear on it, instead of none at all.
 */
export function localRecallMatch(
  message: string,
  candidates: RecallCandidate[],
): string[] {
  const msg = new Set(tokenize(message));
  if (msg.size === 0) return [];
  const scored = candidates
    .map((c) => {
      const name = tokenize(c.file.replace(/\.md$/i, ""));
      const desc = tokenize(c.description ?? "");
      let score = 0;
      for (const t of msg) {
        if (name.includes(t)) score += 2; // a name hit outweighs a description hit
        if (desc.includes(t)) score += 1;
      }
      return { file: c.file, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, RECALL_MAX_NOTES).map((x) => x.file);
}

export function buildRecallPrompt(
  message: string,
  candidates: RecallCandidate[],
): string {
  const notes = candidates
    .map(
      (c) =>
        `- ${c.file} [${c.type ?? "note"}, written ${ageLabel(c.ageDays)}]: ${c.description || "(no description)"}`,
    )
    .join("\n");
  return `Message:\n${message.trim().slice(0, RECALL_MESSAGE_CHARS)}\n\nNotes:\n${notes}`;
}

/**
 * The file names a reply chose, filtered to real candidates, deduplicated and
 * capped. Tolerates prose or a code fence around the JSON, and a bare array —
 * small models add both — but never guesses: anything unparseable is [].
 */
export function parseRecallReply(
  text: string,
  candidates: RecallCandidate[],
): string[] {
  const allowed = new Set(candidates.map((c) => c.file));
  const json = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const file = item.trim().replace(/^.*[\\/]/, "");
    if (allowed.has(file) && !out.includes(file)) out.push(file);
    if (out.length >= RECALL_MAX_NOTES) break;
  }
  return out;
}

/**
 * Ask the small model which candidates to recall. Never throws; [] on any
 * failure, timeout, or when the call would send a BYOK prompt to Core.
 */
export async function selectRelevantMemories(args: {
  message: string;
  candidates: RecallCandidate[];
  chatId?: number | null;
  /** The turn's own model (CLI/editor/user-agent sessions), else the app's. */
  turnModel?: LargeLanguageModel;
}): Promise<string[]> {
  const { message, candidates } = args;
  if (!message.trim() || candidates.length === 0) return [];
  try {
    const { generateText } = await import("ai");
    const { readSettings } = await import("@/main/settings");
    const { getModelClient } = await import("@/ipc/utils/get_model_client");
    const { resolveTitleModel } = await import(
      "@/lib/session-title/generate-title"
    );
    const { catalogSaysReasons } = await import(
      "@/lib/routing/model-reasoning-profile"
    );
    const { recordAuxUsage } = await import(
      "@/lib/usage/turn-usage-aggregator"
    );

    const settings = readSettings();
    const model = await resolveTitleModel(settings, args.turnModel);
    // No key for the provider: getModelClient throws, and recall is skipped below.
    const { modelClient } = await getModelClient(model, settings, { purpose: "memory" });
    const result = await generateText({
      model: modelClient.model,
      system: RECALL_SYSTEM_PROMPT,
      prompt: buildRecallPrompt(message, candidates),
      maxOutputTokens: RECALL_MAX_OUTPUT_TOKENS,
      ...(catalogSaysReasons(model.provider, model.name) === true
        ? { reasoning: "none" as const }
        : {}),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
    });
    recordAuxUsage(args.chatId, result.usage, "memory");
    return parseRecallReply(result.text, candidates);
  } catch (err) {
    logger.warn(
      "recall: selector failed —",
      err instanceof Error ? err.message : err,
    );
    // Fall back to a local keyword match so a message still carries the notes
    // that obviously bear on it, and the failure is never silent.
    const local = localRecallMatch(message, candidates);
    if (local.length > 0) {
      logger.info(`recall: local fallback matched ${local.join(", ")}`);
    } else {
      logger.info("recall: skipped (selector failed and no local match)");
    }
    return local;
  }
}
