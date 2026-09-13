/**
 * Making the context measurement accurate instead of merely approximate.
 *
 * THE PROBLEM WITH `len / 4`. It is the industry's usual stand-in and it runs
 * ±20% on English prose — worse on dense JSON, worse again on CJK, where four
 * characters can be four tokens rather than one. A 20% under-count on a 200,000
 * token window is 40,000 tokens of error, which is the difference between
 * compacting on time and having a turn rejected.
 *
 * THE FIX IS NOT A TOKENIZER. `@anthropic-ai/tokenizer` is CJS + WASM and would
 * need `wasm-unsafe-eval` in the extension CSP, and it would be the WRONG
 * tokenizer anyway: Core 1 is GLM, Core 2 and 3 are OpenAI models, and each
 * counts differently. Shipping one tokenizer to estimate four models is a
 * confident-looking way to stay wrong.
 *
 * THE FIX IS THAT THE PROVIDER ALREADY TELLS US. Every streamed turn ends with a
 * `usage` frame carrying `prompt_tokens` — the exact count, from the model's own
 * tokenizer, for the exact request we sent. The proxy forces
 * `stream_options: {include_usage: true}` because billing depends on it, and it
 * tees the stream so the frame reaches us untouched. It was arriving on every
 * turn and being ignored.
 *
 * TWO THINGS ARE DONE WITH IT, and the first matters more:
 *
 *   1. AN ANCHOR. After a turn, we know EXACTLY what the conversation cost as
 *      sent. Everything added since is a handful of messages. So the estimate
 *      becomes "a measured number, plus a little arithmetic" rather than "a
 *      guess about everything" — and the error is bounded by the size of one
 *      turn instead of by the size of the conversation.
 *
 *   2. A CALIBRATED RATIO, per model. Characters sent divided by tokens
 *      reported. It corrects the estimate for the part that is still estimated,
 *      it is learned from real traffic rather than assumed, and it tracks a
 *      model change automatically because it is keyed by model id.
 *
 * The ratio is kept in storage so a reopened panel starts calibrated rather than
 * relearning on the user's first message.
 */

import { api } from "../shared/browser-api";

const KEY = "atlarix.calibration.v1";

/** The starting point, and the fallback for a model never seen before. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Bounds on a learned ratio.
 *
 * A ratio outside this range is not a language, it is a bug — a usage frame that
 * counted something other than what we sent, a request whose body we mismeasured,
 * or a provider reporting cache-adjusted totals. Dense CJK sits near 1 and very
 * sparse markup near 8; anything beyond is rejected rather than learned, because
 * a bad ratio is worse than no ratio: it is wrong with confidence, and it
 * persists.
 */
const MIN_RATIO = 1;
const MAX_RATIO = 8;

/**
 * How fast a new observation moves the ratio.
 *
 * An exponential moving average rather than the latest value. One turn is not a
 * representative sample — a turn that read a page of Japanese and a turn that
 * read a page of CSS genuinely tokenize differently, and letting either one set
 * the ratio outright makes the context bar jump for reasons the user cannot see.
 */
const SMOOTHING = 0.3;

export interface Calibration {
  /** Learned characters-per-token, by model id. */
  ratios: Record<string, number>;
}

let cache: Calibration | null = null;

function isCalibration(value: unknown): value is Calibration {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.ratios === "object" && c.ratios !== null;
}

/** Load the learned ratios. Never throws; an unreadable store is an empty one. */
export async function loadCalibration(): Promise<Calibration> {
  if (cache) return cache;
  try {
    const bag = await api().storage.local.get<Record<string, unknown>>(KEY);
    const raw = bag?.[KEY];
    cache = isCalibration(raw) ? raw : { ratios: {} };
  } catch {
    cache = { ratios: {} };
  }
  return cache;
}

/** The ratio to estimate with for this model. */
export function ratioFor(calibration: Calibration, model: string): number {
  const learned = calibration.ratios[model];
  return typeof learned === "number" && learned >= MIN_RATIO && learned <= MAX_RATIO
    ? learned
    : DEFAULT_CHARS_PER_TOKEN;
}

/**
 * Fold one measured turn into the ratio for its model.
 *
 * `chars` is the total request text as WE measure it; `promptTokens` is what the
 * provider charged for it. Returns the new ratio, or the old one when the
 * observation is not usable — a very small request is dominated by per-message
 * framing overhead the provider adds and we do not model, so it would teach the
 * wrong lesson.
 */
export function observe(
  calibration: Calibration,
  model: string,
  chars: number,
  promptTokens: number,
): number {
  const current = ratioFor(calibration, model);
  if (promptTokens <= 0 || chars <= 0) return current;
  // Below this, the provider's own per-message overhead dominates and the
  // measurement says more about the protocol than about the text.
  if (promptTokens < 200) return current;

  const observed = chars / promptTokens;
  if (observed < MIN_RATIO || observed > MAX_RATIO) return current;

  const next = current * (1 - SMOOTHING) + observed * SMOOTHING;
  calibration.ratios[model] = next;
  return next;
}

/** Persist the ratios. Fails silently — a lost ratio is relearned next turn. */
export async function saveCalibration(
  calibration: Calibration,
): Promise<void> {
  cache = calibration;
  try {
    await api().storage.local.set({ [KEY]: calibration });
  } catch {
    // See above.
  }
}

/** Test-only: forget the in-memory copy between cases. */
export function __resetCalibrationCache(): void {
  cache = null;
}
