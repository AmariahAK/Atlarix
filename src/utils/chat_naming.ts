/**
 * Chat Naming Utilities
 * Provides hybrid naming: keyword-based extraction + AI-powered naming with fallback
 */

import log from "electron-log";

const logger = log.scope("chat-naming");

/**
 * Extract keywords and create a simple name from a user message
 * Fallback for when AI naming fails or is not yet available
 */
export function generateSimpleChatName(userMessage: string): string {
    // Remove common question words and clean up the message
    const cleaned = userMessage
        .toLowerCase()
        .replace(/^(can you|could you|please|help me|i need|i want to|how do i|how to)\s+/gi, "")
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
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
        "has", "he", "in", "is", "it", "its", "of", "on", "that", "the",
        "to", "was", "will", "with", "this", "there", "their", "my", "me",
        "build", "create", "make", "add", "write", "develop", "generate"
    ]);

    // Action words that indicate what the user wants
    const actionWords = new Set([
        "building", "creating", "making", "adding", "writing", "developing",
        "generating", "designing", "implementing", "coding", "fixing", "debugging"
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

const TITLE_SYSTEM_PROMPT = `Generate a concise, descriptive chat title (max 5 words) based on the conversation below.
Focus on the main topic or task. Return ONLY the title, no quotes or extra text.`;

/**
 * Generate AI-powered chat name based on conversation context.
 * Uses v2.1 summarization model (Fast recommended) from AI Configuration.
 */
export async function generateAIChatName(
    messages: { role: string; content: string }[],
    fallbackName: string
): Promise<string> {
    try {
        const { generateText } = await import("ai");
        const { readSettings } = await import("../main/settings");
        const { getSummarizationModelAsync } = await import("../lib/summarization_model");
        const { getModelClient } = await import("../ipc/utils/get_model_client");

        const settings = readSettings();
        const summarizationModel = await getSummarizationModelAsync(settings);
        const { modelClient } = await getModelClient(summarizationModel, settings);

        const conversationSummary = messages
            .slice(0, 6)
            .map((m) => `${m.role}: ${(m.content || "").slice(0, 200)}`)
            .join("\n");

        const result = await generateText({
            model: modelClient.model,
            system: TITLE_SYSTEM_PROMPT,
            messages: [{ role: "user" as const, content: conversationSummary }],
            maxTokens: 30,
        } as Parameters<typeof generateText>[0]);

        const aiName = result.text.trim().replace(/['"]/g, "");
        return aiName || fallbackName;
    } catch (error) {
        logger.error("AI chat naming failed:", error);
        return fallbackName;
    }
}

/**
 * Should we trigger AI naming for this chat?
 * Triggers after 2-3 messages (1-2 exchanges)
 */
export function shouldTriggerAINaming(messageCount: number): boolean {
    // Trigger after user sends 2nd message (4 total messages: U1, A1, U2, A2)
    return messageCount === 4;
}
