/**
 * Atlarix Memory Tools
 * ===================
 * Tools for AI memory and learning
 */

import * as fs from "fs";
import * as path from "path";
import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";

// Memory storage path
const MEMORY_DIR = path.join(process.env.HOME || "~", ".atlarix", "memory");

// ═══════════════════════════════════════════════════════════
// MEMORY RECALL
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "recall_memory",
    description:
        "Recall what you've learned about the codebase. Returns saved insights and patterns.",
    category: ToolCategory.MEMORY,
    cost: 1,
    requiresWorkspace: true,
    isCore: false,
    parameters: createParameters(
        {
            topic: stringParam(
                "Optional: Specific topic to recall (e.g., 'authentication', 'database schema')"
            ),
        },
        []
    ),
    handler: async ({ topic }) => {
        try {
            // Ensure memory directory exists
            await fs.promises.mkdir(MEMORY_DIR, { recursive: true });

            const memoryFile = path.join(MEMORY_DIR, "learnings.json");

            // Check if memory file exists
            if (!fs.existsSync(memoryFile)) {
                return "No previous learnings found. Use save_learning() to remember insights about the codebase.";
            }

            const memoryData = JSON.parse(
                await fs.promises.readFile(memoryFile, "utf-8")
            );

            // If topic specified, filter to that topic
            if (topic) {
                const learning = memoryData.learnings?.[topic];
                if (!learning) {
                    return `No learnings found for topic: "${topic}"\n\nAvailable topics: ${Object.keys(memoryData.learnings || {}).join(", ")}`;
                }

                return `📚 Recalled: ${topic}\n\n${learning.summary}\n\nRelated files: ${learning.files?.join(", ") || "none"}`;
            }

            // Return all learnings
            const learnings = memoryData.learnings || {};
            const topics = Object.keys(learnings);

            if (topics.length === 0) {
                return "No learnings saved yet.";
            }

            let result = `📚 Recalled ${topics.length} topic(s):\n\n`;
            topics.forEach((t) => {
                result += `**${t}**: ${learnings[t].summary}\n`;
            });

            return result;
        } catch (error) {
            throw new Error(`Failed to recall memory: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// SAVE LEARNING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "save_learning",
    description:
        "Save an insight or learning about the codebase for future reference. Replaces existing learning with same topic.",
    category: ToolCategory.MEMORY,
    cost: 2,
    requiresWorkspace: true,
    isCore: false,
    parameters: createParameters(
        {
            topic: stringParam("Topic name (e.g., 'authentication flow')"),
            summary: stringParam("Summary of what you learned"),
            files: {
                type: "array",
                items: { type: "string" },
                description: "Related file paths",
            },
        },
        ["topic", "summary"]
    ),
    handler: async ({ topic, summary, files = [] }) => {
        try {
            // Ensure memory directory exists
            await fs.promises.mkdir(MEMORY_DIR, { recursive: true });

            const memoryFile = path.join(MEMORY_DIR, "learnings.json");

            // Load existing memory or create new
            let memoryData: any = { learnings: {}, patterns: {} };
            if (fs.existsSync(memoryFile)) {
                memoryData = JSON.parse(
                    await fs.promises.readFile(memoryFile, "utf-8")
                );
            }

            // Save learning
            memoryData.learnings[topic] = {
                summary,
                files,
                timestamp: new Date().toISOString(),
            };

            // Write back to file
            await fs.promises.writeFile(
                memoryFile,
                JSON.stringify(memoryData, null, 2)
            );

            return `💾 Saved learning: "${topic}"\n\n${summary}`;
        } catch (error) {
            throw new Error(`Failed to save learning: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// SEARCH MEMORY
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "search_memory",
    description:
        "Search through saved learnings for specific keywords or patterns.",
    category: ToolCategory.MEMORY,
    cost: 1,
    requiresWorkspace: true,
    isCore: false,
    parameters: createParameters(
        {
            query: stringParam("Search query (keywords to find in learnings)"),
        },
        ["query"]
    ),
    handler: async ({ query }) => {
        try {
            const memoryFile = path.join(MEMORY_DIR, "learnings.json");

            if (!fs.existsSync(memoryFile)) {
                return "No learnings saved yet.";
            }

            const memoryData = JSON.parse(
                await fs.promises.readFile(memoryFile, "utf-8")
            );

            const learnings = memoryData.learnings || {};
            const matches: string[] = [];

            // Search in topic names and summaries
            Object.keys(learnings).forEach((topic) => {
                const learning = learnings[topic];
                const searchText =
                    `${topic} ${learning.summary}`.toLowerCase();

                if (searchText.includes(query.toLowerCase())) {
                    matches.push(
                        `**${topic}**: ${learning.summary}\n  Files: ${learning.files?.join(", ") || "none"}`
                    );
                }
            });

            if (matches.length === 0) {
                return `No learnings found matching: "${query}"`;
            }

            return `🔍 Found ${matches.length} matching learning(s):\n\n${matches.join("\n\n")}`;
        } catch (error) {
            throw new Error(`Failed to search memory: ${error}`);
        }
    },
});
