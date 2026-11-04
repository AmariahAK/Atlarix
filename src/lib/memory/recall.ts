/**
 * Memory recall — which project notes bear on the user's next message.
 *
 * Local-first: a deterministic BM25 score over each note's file name and
 * description, boosted by per-note learned weights, answers every message that
 * shares a word with a note — so the hot path makes NO model call. The small
 * selector model is now only the fallback for a message the local scorer cannot
 * match at all (no shared words: a purely semantic match), and any failure of
 * that model simply recalls nothing.
 *
 * Weights live in `<memoryDir>/weights.json`, one small object keyed by note
 * file name. A recalled note gains a little weight (capped); a note left alone
 * decays back toward 1.0 over a halflife, so a once-hot note stops out-ranking
 * a fresh one. Decay is applied lazily on every read and persisted only when a
 * recall bumps something, so the store is not rewritten for a message that
 * recalls nothing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import type { LargeLanguageModel } from "@/lib/schemas";

const logger = log.scope("memory-recall");

/** At most this many notes are attached to one message. */
export const RECALL_MAX_NOTES = 5;
/**
 * How long the selector model may take. The reply is a short JSON list, so a
 * healthy model answers in well under this; anything slower is usually the
 * overload the local scorer exists to route around. Kept short so a failing
 * recall does not hold the turn.
 */
const RECALL_TIMEOUT_MS = 2_500;
/** Runaway insurance only — the reply is a short JSON list. */
const RECALL_MAX_OUTPUT_TOKENS = 512;
/** The message as the selector sees it; the head carries the intent. */
const RECALL_MESSAGE_CHARS = 4_000;

// ── Learned weights ─────────────────────────────────────────────────────────

/** The file inside the memory directory that stores learned note weights. */
export const WEIGHTS_FILE = "weights.json";
/** A recalled note may rise to at most this multiple of a neutral one. */
const WEIGHT_CAP = 4;
/** Gained per recall. */
const WEIGHT_BUMP = 0.5;
/** Days to halve a weight's distance back to neutral (1.0). */
const WEIGHT_DECAY_HALFLIFE_DAYS = 14;

export type MemoryWeight = { w: number; lastUsedAt: number };
/** Note file name → its learned weight. */
export type MemoryWeights = Record<string, MemoryWeight>;

/** A weight eased back toward 1.0 after `daysSinceUse` idle days. */
export function decayWeight(w: number, daysSinceUse: number): number {
  if (!(daysSinceUse > 0)) return w;
  return 1 + (w - 1) * Math.pow(0.5, daysSinceUse / WEIGHT_DECAY_HALFLIFE_DAYS);
}

/** Decay every entry; drop ones that have returned to neutral. */
export function applyDecay(weights: MemoryWeights, now: number): MemoryWeights {
  const out: MemoryWeights = {};
  for (const [file, v] of Object.entries(weights)) {
    const days = v.lastUsedAt > 0 ? (now - v.lastUsedAt) / 86_400_000 : Infinity;
    const w = decayWeight(v.w, days);
    if (Math.abs(w - 1) < 0.01) continue;
    out[file] = { w, lastUsedAt: v.lastUsedAt };
  }
  return out;
}

/** Add `WEIGHT_BUMP` to each named note (capped), stamping the use time. */
export function bumpWeights(
  weights: MemoryWeights,
  files: string[],
  now: number,
): MemoryWeights {
  const out: MemoryWeights = { ...weights };
  for (const file of files) {
    const prev = out[file];
    out[file] = {
      w: Math.min(WEIGHT_CAP, (prev?.w ?? 1) + WEIGHT_BUMP),
      lastUsedAt: now,
    };
  }
  return out;
}

/** Read the weights file; {} when missing or unreadable (never throws). */
export async function readWeights(dir: string): Promise<MemoryWeights> {
  try {
    const raw = await fs.readFile(path.join(dir, WEIGHTS_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: MemoryWeights = {};
    for (const [file, v] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = v as { w?: unknown; lastUsedAt?: unknown } | null;
      if (!entry || typeof entry !== "object" || typeof entry.w !== "number") continue;
      out[file] = {
        w: entry.w,
        lastUsedAt: typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function writeWeights(dir: string, weights: MemoryWeights): Promise<void> {
  try {
    await fs.writeFile(path.join(dir, WEIGHTS_FILE), JSON.stringify(weights), "utf8");
  } catch (err) {
    logger.warn(
      "recall: could not write weights —",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Persist decayed weights — called only when a recall bumped something. */
async function persistWeights(
  dir: string,
  weights: MemoryWeights,
  now: number,
): Promise<void> {
  await writeWeights(dir, applyDecay(weights, now));
}

// ── Local scoring ───────────────────────────────────────────────────────────

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

/** Words that never identify a note in the local scorer. */
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

// BM25 over the candidate set: IDF from how many notes carry each term. A
// note's "document" is its file name (twice, so a name hit outweighs a
// description hit) plus its description.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function docTokens(c: RecallCandidate): string[] {
  const name = tokenize(c.file.replace(/\.md$/i, ""));
  const desc = tokenize(c.description ?? "");
  return [...name, ...name, ...desc];
}

function idf(term: string, docs: string[][]): number {
  const containing = docs.reduce((n, d) => n + (d.includes(term) ? 1 : 0), 0);
  return Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5));
}

function bm25(
  query: Set<string>,
  doc: string[],
  docs: string[][],
  avgLen: number,
): number {
  let score = 0;
  for (const term of query) {
    let tf = 0;
    for (const t of doc) if (t === term) tf++;
    if (tf === 0) continue;
    score +=
      idf(term, docs) *
      ((tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgLen))));
  }
  return score;
}

/**
 * Deterministic, free, local recall: BM25 over each candidate's file name and
 * description (boosted by learned weights when given) against the message's
 * tokens, returning the best few. This is the PRIMARY path — only a message
 * with no word overlap at all falls through to the model.
 */
export function localRecallMatch(
  message: string,
  candidates: RecallCandidate[],
  weights?: MemoryWeights | null,
): string[] {
  const query = tokenize(message);
  if (query.length === 0 || candidates.length === 0) return [];
  const qset = new Set(query);
  const docs = candidates.map(docTokens);
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const scored = candidates
    .map((c, i) => {
      const score = bm25(qset, docs[i]!, docs, avgLen) * (weights?.[c.file]?.w ?? 1);
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
 * Which candidates to recall. Local first: a BM25 match (word overlap) is
 * answered with no model call and bumps the recalled notes' weights. Only when
 * the local scorer has nothing — a purely semantic match — is the small model
 * asked, one attempt, short timeout; its failure recalls nothing (the local
 * pass already ran). Never throws.
 */
export async function selectRelevantMemories(args: {
  message: string;
  candidates: RecallCandidate[];
  chatId?: number | null;
  /** The turn's own model (CLI/editor/user-agent sessions), else the app's. */
  turnModel?: LargeLanguageModel;
  /** The project-memory dir, where weights.json lives; omit to skip learning. */
  memoryDir?: string | null;
}): Promise<string[]> {
  const { message, candidates, memoryDir } = args;
  if (!message.trim() || candidates.length === 0) return [];

  const now = Date.now();
  let weights: MemoryWeights = {};
  if (memoryDir) {
    weights = applyDecay(await readWeights(memoryDir).catch(() => ({})), now);
  }

  const local = localRecallMatch(message, candidates, weights);
  if (local.length > 0) {
    if (memoryDir) await persistWeights(memoryDir, bumpWeights(weights, local, now), now);
    return local;
  }

  // No word overlap — ask the small model for a semantic match. One attempt,
  // short timeout; any failure recalls nothing.
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
    const chosen = parseRecallReply(result.text, candidates);
    if (memoryDir && chosen.length > 0) {
      await persistWeights(memoryDir, bumpWeights(weights, chosen, now), now);
    }
    return chosen;
  } catch (err) {
    logger.warn(
      "recall: selector failed —",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
