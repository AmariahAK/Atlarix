/**
 * Chat Naming Utilities
 * Hybrid approach: Instant title from first message + AI-generated title
 */

import log from "electron-log";

const logger = log.scope("chat-naming");

/**
 * Generate instant title from first user message
 * Used immediately when chat is created
 */
export function generateInstantTitle(firstMessage: string): string {
    const cleaned = firstMessage.trim();

    if (cleaned.length === 0) {
        return "New chat";
    }

    // Remove special characters and extra whitespace
    const normalized = cleaned.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ");

    // Take first 50 characters
    const truncated = normalized.slice(0, 50);

    // Smart word boundary truncation
    const words = truncated.split(" ");

    if (words.length > 6) {
        return words.slice(0, 6).join(" ") + "...";
    }

    if (truncated.length === 50 && normalized.length > 50) {
        return truncated + "...";
    }

    return truncated;
}

/**
 * Generate AI-based title from conversation
 * Used after first AI response is received
 * 
 * @param firstUserMessage - First message from user
 * @param firstAssistantResponse - First response from assistant
 * @param generateFn - AI generation function (injected)
 */
export async function generateAITitle(
    firstUserMessage: string,
    firstAssistantResponse: string,
    generateFn: (prompt: string) => Promise<string>
): Promise<string | null> {
    try {
        const prompt = `Generate a concise 3-5 word title for this conversation. DO NOT use quotes or punctuation.

User: ${firstUserMessage.slice(0, 200)}
Assistant: ${firstAssistantResponse.slice(0, 200)}

Title:`;

        const title = await Promise.race([
            generateFn(prompt),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error("Timeout")), 3000)
            )
        ]);

        // Clean up AI response
        const cleaned = title
            .trim()
            .replace(/^["']|["']$/g, "") // Remove quotes
            .replace(/\.$/, "") // Remove trailing period
            .slice(0, 60); // Max 60 chars

        if (cleaned.length > 0 && cleaned.split(" ").length >= 2) {
            logger.info(`Generated AI title: "${cleaned}"`);
            return cleaned;
        }

        return null;
    } catch (error) {
        logger.warn(`Failed to generate AI title: ${error}`);
        return null;
    }
}

/**
 * Get chat title with fallback chain
 * 
 * Priority:
 * 1. AI-generated title (if available)
 * 2. Instant title from first message
 * 3. "New chat" default
 */
export function getChatTitle(
    aiTitle: string | null,
    instantTitle: string | null,
    firstMessage: string | null
): string {
    if (aiTitle && aiTitle.trim().length > 0) {
        return aiTitle;
    }

    if (instantTitle && instantTitle.trim().length > 0) {
        return instantTitle;
    }

    if (firstMessage) {
        return generateInstantTitle(firstMessage);
    }

    return "New chat";
}

/**
 * Detect chat topic category from content
 * Used for organizing chats
 */
export function detectChatCategory(title: string, content: string): string {
    const combined = (title + " " + content).toLowerCase();

    const categories: Record<string, string[]> = {
        "Code": ["code", "function", "implement", "debug", "error", "fix"],
        "Design": ["design", "ui", "ux", "layout", "style", "component"],
        "Planning": ["plan", "strategy", "roadmap", "architecture", "structure"],
        "Question": ["what", "how", "why", "when", "explain", "?"],
        "Documentation": ["document", "readme", "api", "guide", "tutorial"],
    };

    for (const [category, keywords] of Object.entries(categories)) {
        if (keywords.some(keyword => combined.includes(keyword))) {
            return category;
        }
    }

    return "General";
}
