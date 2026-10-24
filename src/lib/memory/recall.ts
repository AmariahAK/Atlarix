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
const RECALL_TIMEOUT_MS = 8_000;
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
    logger.warn("recall: skipped —", err instanceof Error ? err.message : err);
    return [];
  }
}
