/**
 * Text-Based Tool Call Parser
 * ===========================
 * Parses tool calls that models output as text instead of using native function calling.
 * Handles various XML formats used by different models:
 * - MiniMax: <minimax:tool_call><invoke name="..."><parameter name="...">...</parameter></invoke></minimax:tool_call>
 * - Generic: <tool_call name="...">...</tool_call>
 * - Claude-style: <function_call name="...">...</function_call>
 * - Legacy angle form: <tool_call><function=tool_name><parameter=key>value</parameter>...</function></tool_call>
 */

import log from "electron-log";

const logger = log.scope("text-tool-parser");

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export interface ParsedToolCall {
    toolName: string;
    args: Record<string, any>;
    rawMatch: string;
}

// ════════════════════════════════════════════════════════════════════════════
// PARSERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse MiniMax format tool calls.
 * Example:
 * <minimax:tool_call>
 * <invoke name="list_files">
 * <parameter name="path">.</parameter>
 * </invoke>
 * </minimax:tool_call>
 */
function parseMiniMaxFormat(text: string): ParsedToolCall[] {
    const results: ParsedToolCall[] = [];
    const regex = /<minimax:tool_call>\s*<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>\s*<\/minimax:tool_call>/gi;

    let match;
    while ((match = regex.exec(text)) !== null) {
        const toolName = match[1];
        const paramsBlock = match[2];

        // Parse parameters
        const args: Record<string, any> = {};
        const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([^<]*)<\/parameter>/gi;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
            const paramName = paramMatch[1];
            const paramValue = paramMatch[2].trim();
            // Try to parse as JSON, otherwise keep as string
            try {
                args[paramName] = JSON.parse(paramValue);
            } catch {
                args[paramName] = paramValue;
            }
        }

        results.push({
            toolName,
            args,
            rawMatch: match[0],
        });

        logger.log(`[MiniMax] Parsed tool call: ${toolName}`, args);
    }

    return results;
}

/**
 * Parse generic XML tool call format.
 * Example:
 * <tool_call name="list_files">{"path": "."}</tool_call>
 */
function parseGenericXMLFormat(text: string): ParsedToolCall[] {
    const results: ParsedToolCall[] = [];
    const regex = /<tool_call\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/tool_call>/gi;

    let match;
    while ((match = regex.exec(text)) !== null) {
        const toolName = match[1];
        const argsText = match[2].trim();

        let args: Record<string, any> = {};
        try {
            args = JSON.parse(argsText);
        } catch {
            // If not valid JSON, try key=value format
            const kvRegex = /(\w+)\s*[:=]\s*["']?([^"'\n]+)["']?/g;
            let kvMatch;
            while ((kvMatch = kvRegex.exec(argsText)) !== null) {
                args[kvMatch[1]] = kvMatch[2].trim();
            }
        }

        results.push({
            toolName,
            args,
            rawMatch: match[0],
        });
    }

    return results;
}

/**
 * Parse function call format (Claude-style).
 * Example:
 * <function_call name="list_files">{"path": "."}</function_call>
 */
function coerceAngleBracketParamValue(raw: string): unknown {
    const t = raw.trim();
    if (t === "True" || t === "true") return true;
    if (t === "False" || t === "false") return false;
    try {
        return JSON.parse(t);
    } catch {
        return t;
    }
}

/**
 * Parse <tool_call><function=tool_name>...</function></tool_call> with <parameter=key>value</parameter>.
 */
function parseLegacyAngleFunctionFormat(text: string): ParsedToolCall[] {
    const results: ParsedToolCall[] = [];
    const blockRe =
        /<tool_call\s*>\s*<function\s*=\s*([a-zA-Z0-9_]+)\s*>\s*([\s\S]*?)<\/function\s*>\s*<\/tool_call\s*>/gi;

    let match;
    while ((match = blockRe.exec(text)) !== null) {
        const toolName = match[1];
        const paramsBlock = match[2];
        const args: Record<string, any> = {};
        const paramRe = /<parameter\s*=\s*([a-zA-Z0-9_]+)\s*>\s*([\s\S]*?)<\/parameter\s*>/gi;
        let pm;
        while ((pm = paramRe.exec(paramsBlock)) !== null) {
            args[pm[1]] = coerceAngleBracketParamValue(pm[2]);
        }

        results.push({
            toolName,
            args,
            rawMatch: match[0],
        });

        logger.log(`[Legacy function=] Parsed tool call: ${toolName}`, args);
    }

    return results;
}

function parseFunctionCallFormat(text: string): ParsedToolCall[] {
    const results: ParsedToolCall[] = [];
    const regex = /<function_call\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/function_call>/gi;

    let match;
    while ((match = regex.exec(text)) !== null) {
        const toolName = match[1];
        const argsText = match[2].trim();

        let args: Record<string, any> = {};
        try {
            args = JSON.parse(argsText);
        } catch {
            args = { raw: argsText };
        }

        results.push({
            toolName,
            args,
            rawMatch: match[0],
        });
    }

    return results;
}

/**
 * Parse invoke format (simpler).
 * Example:
 * <invoke name="list_files">
 * <parameter name="path">.</parameter>
 * </invoke>
 */
function parseInvokeFormat(text: string): ParsedToolCall[] {
    const results: ParsedToolCall[] = [];
    // Match standalone <invoke> blocks not inside <minimax:tool_call>
    const regex = /(?<!<minimax:tool_call>\s*)<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>(?!\s*<\/minimax:tool_call>)/gi;

    let match;
    while ((match = regex.exec(text)) !== null) {
        const toolName = match[1];
        const paramsBlock = match[2];

        const args: Record<string, any> = {};
        const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([^<]*)<\/parameter>/gi;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
            const paramName = paramMatch[1];
            const paramValue = paramMatch[2].trim();
            try {
                args[paramName] = JSON.parse(paramValue);
            } catch {
                args[paramName] = paramValue;
            }
        }

        results.push({
            toolName,
            args,
            rawMatch: match[0],
        });
    }

    return results;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN PARSER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Detect if text contains tool call patterns.
 */
export function containsTextToolCall(text: string): boolean {
    const patterns = [
        /<minimax:tool_call>/i,
        /<tool_call\s+name=/i,
        /<tool_call\s*>\s*<function\s*=/i,
        /<function\s*=\s*\w+/i,
        /<function_call\s+name=/i,
        /<invoke\s+name="[^"]+"\s*>/i,
    ];
    return patterns.some(p => p.test(text));
}

/**
 * Parse all tool calls from text response.
 * Tries multiple formats and returns all found.
 */
export function parseTextToolCalls(text: string): ParsedToolCall[] {
    const results: ParsedToolCall[] = [];

    // Try each format
    results.push(...parseMiniMaxFormat(text));
    results.push(...parseGenericXMLFormat(text));
    results.push(...parseFunctionCallFormat(text));
    results.push(...parseLegacyAngleFunctionFormat(text));

    // Only try invoke format if nothing else matched (avoid duplicates)
    if (results.length === 0) {
        results.push(...parseInvokeFormat(text));
    }

    // Remove duplicates (same tool name and args)
    const seen = new Set<string>();
    return results.filter(r => {
        const key = `${r.toolName}:${JSON.stringify(r.args)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Extract text content without tool call XML.
 */
export function stripToolCallXML(text: string): string {
    return text
        .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi, "")
        .replace(/<tool_call\s*>\s*<function\s*=\s*[a-zA-Z0-9_]+\s*>[\s\S]*?<\/function\s*>\s*<\/tool_call\s*>/gi, "")
        .replace(/<tool_call\s+name="[^"]+">[\s\S]*?<\/tool_call>/gi, "")
        .replace(/<function_call\s+name="[^"]+">[\s\S]*?<\/function_call>/gi, "")
        .replace(/<invoke\s+name="[^"]+"[^>]*>[\s\S]*?<\/invoke>/gi, "")
        .trim();
}
