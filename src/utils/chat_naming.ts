/**
 * Chat Naming Utilities
 * Provides hybrid naming: keyword-based extraction + AI-powered naming with fallback
 */

import log from "electron-log";
import { extractVisibleAnswerMarkdown } from "../lib/chat/answer-display";

const logger = log.scope("chat-naming");

/**
 * Extract keywords and create a simple name from a user message
 * Fallback for when AI naming fails or is not yet available
 */
export function generateSimpleChatName(userMessage: string): string {
  // Remove common question words and clean up the message
  const cleaned = userMessage
    .toLowerCase()
    .replace(
      /^(can you|could you|please|help me|i need|i want to|how do i|how to)\s+/gi,
      "",
    )
    .replace(/[?!.]/g, "")
    .trim();

  // Extract key action verbs and nouns
  const keywords = extractKeywords(cleaned);

  if (keywords.length === 0) {
    return "New chat";
  }

  // Capitalize first letter of each word
  const name = keywords
    .slice(0, 4) // Limit to 4 words max
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  return name || "New chat";
}

/**
 * Extract meaningful keywords from text
 */
function extractKeywords(text: string): string[] {
  // Common stop words to filter out
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "he",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "that",
    "the",
    "to",
    "was",
    "will",
    "with",
    "this",
    "there",
    "their",
    "my",
    "me",
    "build",
    "create",
    "make",
    "add",
    "write",
    "develop",
    "generate",
  ]);

  // Action words that indicate what the user wants
  const actionWords = new Set([
    "building",
    "creating",
    "making",
    "adding",
    "writing",
    "developing",
    "generating",
    "designing",
    "implementing",
    "coding",
    "fixing",
    "debugging",
  ]);

  const words = text.split(/\s+/).filter((word) => word.length > 2);
  const keywords: string[] = [];

  // First, look for action words
  for (const word of words) {
    if (actionWords.has(word)) {
      keywords.push(word);
      break;
    }
  }

  // Then add important nouns/subjects
  for (const word of words) {
    if (!stopWords.has(word) && !actionWords.has(word) && keywords.length < 4) {
      keywords.push(word);
    }
  }

  return keywords;
}

const TITLE_SYSTEM_PROMPT = `Generate a short chat title (3–5 words) for the topic or task in the messages below.
Examples: "Fix login redirect", "Add dark mode toggle", "PostgreSQL migration plan".
Return ONLY the title text — no quotes, no punctuation-only lines, and no meta phrases like "Based on the conversation".`;

const LOW_QUALITY_TITLE_PATTERNS: RegExp[] = [
  /^based on (the |this )?conversation/i,
  /^based on (the |your )?messages?/i,
  /^conversation$/i,
  /^chat$/i,
  /^new chat$/i,
  /^untitled$/i,
  /^summary$/i,
  /^discussion$/i,
];

/** Tool args, JSON blobs, and tag debris are not valid session/chat titles. */
export function looksLikeToolOrStructuredDebrisTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (/^json\s*[[{]/i.test(t)) return true;
  if (/^\s*[[{]/.test(t)) return true;
  if (t.startsWith("```")) return true;
  if (/atlarix-(?:tool|mcp)-/i.test(t)) return true;
  if (/<\/?[a-z][\w-]*[\s>]/i.test(t)) return true;
  if (/\baction\s*:\s*[\w-]+/i.test(t) && /\bpath\s*:\s*\S/i.test(t))
    return true;
  if (
    /\b(get_|search_|read_|write_|explore_|list_)[\w-]*/i.test(t) &&
    /[{[]/.test(t)
  ) {
    return true;
  }
  return false;
}

/** Reject generic / meta model outputs that are not real titles. */
export function isLowQualityGeneratedTitle(title: string): boolean {
  const t = title.trim();
  if (!t || t.length < 3) return true;
  if (LOW_QUALITY_TITLE_PATTERNS.some((p) => p.test(t))) return true;
  if (/^based on\b/i.test(t)) return true;
  if (looksLikeToolOrStructuredDebrisTitle(t)) return true;
  return false;
}

/** Strip thinking/tool XML so title models see user-visible prose only. */
export function stripContentForTitleSource(
  content: string,
  role: "user" | "assistant" | "tool" | string,
): string {
  const raw = (content || "").trim();
  if (!raw) return "";
  if (role === "assistant" || role === "tool") {
    const visible = extractVisibleAnswerMarkdown(raw);
    if (visible.trim().length >= 8) return visible.trim();
  }
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pick AI title when valid; otherwise derive from the first user message. */
export function resolveGeneratedChatTitle(
  generated: string,
  messages: { role: string; content: string }[],
  fallbackName: string,
): string {
  const cleaned = generated
    .trim()
    .replace(/^["']|["']$/g, "")
    .slice(0, 80);
  if (cleaned && !isLowQualityGeneratedTitle(cleaned)) return cleaned;
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser?.content?.trim()) {
    return generateSimpleChatName(firstUser.content).slice(0, 80);
  }
  return fallbackName;
}

/**
 * Generate AI-powered chat name based on conversation context.
 * Uses v2.1 summarization model (Fast recommended) from AI Configuration.
 */
export async function generateAIChatName(
  messages: { role: string; content: string }[],
  fallbackName: string,
): Promise<string> {
  try {
    const { generateText } = await import("ai");
    const { readSettings } = await import("../main/settings");
    const { getSummarizationModelAsync } = await import(
      "../lib/summarization_model"
    );
    const { getModelClient } = await import("../ipc/utils/get_model_client");

    const settings = readSettings();
    const summarizationModel = await getSummarizationModelAsync(settings);
    const { modelClient } = await getModelClient(summarizationModel, settings);

    const conversationSummary = messages
      .slice(0, 6)
      .map((m) => {
        const body = stripContentForTitleSource(m.content || "", m.role).slice(
          0,
          200,
        );
        return `${m.role}: ${body}`;
      })
      .filter((line) => line.length > `${line.split(":")[0]}: `.length)
      .join("\n");

    const result = await generateText({
      model: modelClient.model,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: conversationSummary }],
      maxTokens: 30,
    } as Parameters<typeof generateText>[0]);

    const aiName = result.text.trim().replace(/['"]/g, "");
    return resolveGeneratedChatTitle(aiName, messages, fallbackName);
  } catch (error) {
    logger.error("AI chat naming failed:", error);
    return fallbackName;
  }
}
