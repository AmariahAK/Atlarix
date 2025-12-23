/**
 * Atlarix Web Tools
 * ================
 * Tools for web search, URL reading, and parsing
 */

import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";

// ═══════════════════════════════════════════════════════════
// WEB SEARCH
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "web_search",
    description:
        "Search the web for information. Returns top results with titles, URLs, and snippets.",
    category: ToolCategory.WEB,
    cost: 3,
    requiresWorkspace: false,
    isCore: true,
    parameters: createParameters(
        {
            query: stringParam("Search query"),
            num_results: {
                type: "number",
                description: "Number of results to return (default: 5)",
            },
        },
        ["query"]
    ),
    handler: async ({ query, num_results = 5 }) => {
        try {
            // Use DuckDuckGo instant answer API (no key required)
            const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
            const response = await fetch(searchUrl);
            const data = await response.json();

            const results: string[] = [];

            // Add instant answer if available
            if (data.Abstract) {
                results.push(`📌 **${data.Heading}**`);
                results.push(`${data.Abstract}`);
                if (data.AbstractURL) {
                    results.push(`🔗 ${data.AbstractURL}\n`);
                }
            }

            // Add related topics
            if (data.RelatedTopics && data.RelatedTopics.length > 0) {
                const topics = data.RelatedTopics.slice(0, num_results);
                topics.forEach((topic: any, idx: number) => {
                    if (topic.Text && topic.FirstURL) {
                        results.push(`${idx + 1}. **${topic.Text.split(" - ")[0]}**`);
                        results.push(`   ${topic.Text}`);
                        results.push(`   🔗 ${topic.FirstURL}\n`);
                    }
                });
            }

            if (results.length === 0) {
                return `No results found for: "${query}"\n\nTry rephrasing your search or use more specific keywords.`;
            }

            return `Search results for: "${query}"\n\n${results.join("\n")}`;
        } catch (error) {
            throw new Error(`Web search failed: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// URL READING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "read_url",
    description:
        "Fetch and read content from a URL. Returns the page content as text.",
    category: ToolCategory.WEB,
    cost: 2,
    requiresWorkspace: false,
    isCore: true,
    parameters: createParameters(
        {
            url: stringParam("URL to fetch"),
            max_length: {
                type: "number",
                description: "Maximum content length to return (default: 5000 chars)",
            },
        },
        ["url"]
    ),
    handler: async ({ url, max_length = 5000 }) => {
        try {
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Atlarix/1.0",
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const contentType = response.headers.get("content-type") || "";

            // Handle JSON
            if (contentType.includes("application/json")) {
                const json = await response.json();
                return `URL: ${url}\nContent-Type: JSON\n\n${JSON.stringify(json, null, 2).slice(0, max_length)}`;
            }

            // Handle HTML/Text
            const text = await response.text();

            // Basic HTML stripping (for simple cases)
            const cleanText = text
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            const truncated = cleanText.slice(0, max_length);
            const wasTruncated = cleanText.length > max_length;

            return `URL: ${url}\nContent-Type: ${contentType}\nLength: ${cleanText.length} chars${wasTruncated ? " (truncated)" : ""}\n\n${truncated}`;
        } catch (error) {
            throw new Error(`Failed to fetch URL: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// DATE/TIME
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "get_current_time",
    description:
        "Get the current date and time in various formats (local, UTC, unix timestamp)",
    category: ToolCategory.DATETIME,
    cost: 0,
    requiresWorkspace: false,
    isCore: true,
    parameters: createParameters(
        {
            timezone: stringParam(
                "Optional: Timezone (e.g., 'America/New_York', 'Europe/London')"
            ),
        },
        []
    ),
    handler: async ({ timezone }) => {
        const now = new Date();

        const formats = {
            local: now.toLocaleString(),
            iso: now.toISOString(),
            utc: now.toUTCString(),
            unix: Math.floor(now.getTime() / 1000),
            date: now.toLocaleDateString(),
            time: now.toLocaleTimeString(),
        };

        let result = `Current Date & Time:\n\n`;
        result += `📅 Local: ${formats.local}\n`;
        result += `🌍 UTC: ${formats.utc}\n`;
        result += `📊 ISO 8601: ${formats.iso}\n`;
        result += `⏱️  Unix Timestamp: ${formats.unix}\n`;

        if (timezone) {
            try {
                const zonedTime = now.toLocaleString("en-US", {
                    timeZone: timezone,
                });
                result += `🌐 ${timezone}: ${zonedTime}\n`;
            } catch {
                result += `\n⚠️ Invalid timezone: ${timezone}`;
            }
        }

        return result;
    },
});

// ═══════════════════════════════════════════════════════════
// URL PARSING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "parse_url",
    description:
        "Parse a URL and extract its components (protocol, host, path, query params, etc.)",
    category: ToolCategory.WEB,
    cost: 0,
    requiresWorkspace: false,
    isCore: true,
    parameters: createParameters(
        {
            url: stringParam("URL to parse"),
        },
        ["url"]
    ),
    handler: async ({ url }) => {
        try {
            const parsed = new URL(url);

            let result = `URL Components:\n\n`;
            result += `🔗 Full URL: ${url}\n`;
            result += `📋 Protocol: ${parsed.protocol}\n`;
            result += `🌐 Host: ${parsed.host}\n`;
            result += `📁 Path: ${parsed.pathname}\n`;

            if (parsed.search) {
                result += `🔍 Query: ${parsed.search}\n`;
                result += `\nQuery Parameters:\n`;
                parsed.searchParams.forEach((value, key) => {
                    result += `  • ${key} = ${value}\n`;
                });
            }

            if (parsed.hash) {
                result += `#️⃣ Hash: ${parsed.hash}\n`;
            }

            if (parsed.username || parsed.password) {
                result += `🔐 Auth: ${parsed.username}:***\n`;
            }

            return result;
        } catch (error) {
            throw new Error(`Invalid URL: ${error}`);
        }
    },
});
