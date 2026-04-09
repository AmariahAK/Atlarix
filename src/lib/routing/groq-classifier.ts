/**
 * External Groq API classifier for auto model tier routing (main process).
 */

import log from "electron-log";
import type { ModelTier } from "./capability-registry";

const logger = log.scope("groq-classifier");

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `You are a routing classifier for an AI coding copilot.
The user message includes: (1) Task state — current UI mode, agent mode, whether a plan exists, prior auto-routing tiers; (2) Recent conversation — prior user/assistant turns; (3) Current message — the new user turn to classify.

Choose tier for the **current message** only, using task state and recent turns for disambiguation (e.g. short replies like "ok" or "try again" follow the thread depth).

Respond with ONLY valid JSON and nothing else:
{"tier": "fast" | "balanced" | "thinking", "confidence": 0.0-1.0}

fast: simple questions, quick edits, one-liners, chit-chat, syntax help
balanced: code generation, bug fixes, feature implementation, explanations, refactoring
thinking: system architecture, complex debugging, security review, multi-file refactors, deep reasoning, design decisions

Respond with ONLY the JSON object. No explanation.`;

function parseTierJson(text: string): { tier: ModelTier; confidence: number } | null {
  const raw = text.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as { tier?: unknown; confidence?: unknown };
  const tierStr = typeof o.tier === "string" ? o.tier.toLowerCase().trim() : "";
  const tiers = new Set(["fast", "balanced", "thinking"]);
  if (!tiers.has(tierStr)) return null;
  const tier = tierStr as ModelTier;
  let c = typeof o.confidence === "number" ? o.confidence : Number(o.confidence);
  if (Number.isNaN(c)) return null;
  c = Math.max(0, Math.min(1, c));
  return { tier, confidence: c };
}

/**
 * Classify tier via Groq from a pre-built user blob (task state + history + current message).
 * Returns null on any failure (missing key, timeout, error). Never throws.
 */
export async function classifyPromptWithGroq(
  userBlob: string,
  maxUserChars = 12_000,
): Promise<{ tier: ModelTier; confidence: number } | null> {
  const apiKey = (process.env.GROQ_CLASSIFIER_API_KEY ?? "").trim();
  const model = (process.env.GROQ_CLASSIFIER_MODEL ?? "").trim();
  if (!apiKey || !model) {
    return null;
  }

  const userContent = userBlob.slice(0, maxUserChars);

  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: 30,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(2000),
    });

    if (res.status === 429) {
      logger.warn("Groq classifier rate limited, using fallback");
      return null;
    }

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;
    return parseTierJson(text);
  } catch {
    return null;
  }
}
