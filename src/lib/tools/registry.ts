/**
 * Atlarix Tool Registry
 * ====================
 * Central registry for all available tools
 */

import { isMainProcessNode } from "../runtime/is-main-node";
import { guardToolCall } from "./guard";
import { resolveRecoverySuggestion } from "./tool-error-patterns";
import { isFailedToolResult } from "./tool-result-status";
import { extractImageMedia } from "@/lib/ai/tool-model-output";

// NOTE: this module is imported by both the Electron main process AND the renderer
// (e.g. `ToolIndicator.tsx` reads `ToolRegistry` for UI metadata). Anything that
// touches `node:*` must therefore be loaded lazily *inside* a function, never at
// module-top, AND guarded by `isMainProcessNode()` (not just `process.versions.node`,
// since Electron's renderer exposes that too). Otherwise Vite's browser bundle blows
// up with "Module 'node:crypto' has been externalized for browser compatibility".

/**
 * OpenAI-style function-tool schema, as emitted by `toAISDKFormat`.
 *
 * Moved here from `providers/base-provider.ts` when that file was deleted: it
 * was a dead port of a pre-Atlarix Python agent (`StackSense base_agent.py`) —
 * an abstract class nobody extended, plus a system prompt nobody sent — and this
 * type was the only thing left alive in it.
 */
export interface Tool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
}

// Token budgets: outputs whose ESTIMATED tokens exceed the budget (or whose raw
// size exceeds the byte ceiling) are truncated IN-BAND to a head+tail preview —
// tails carry exit codes, error summaries, and final test results. v14: no more
// disk spill. Mirrors opencode/claude-code — over-budget output is truncated in
// place with a STATELESS hint (re-read the original file via offset/limit, or
// narrow the command), never a fragile temp-file path the model must re-fetch.
const TOOL_OUTPUT_BYTE_CEILING = 50_000;
/** Below this char count, never truncate (≈ well under the token budget) — skips tokenizing small outputs. */
const TOOL_OUTPUT_CHAR_FLOOR = 16_000;
const TOOL_OUTPUT_TOKEN_BUDGET = 6_000;
const TOOL_OUTPUT_PREVIEW_HEAD_TOKENS = 1_500;
const TOOL_OUTPUT_PREVIEW_TAIL_TOKENS = 500;
// v14: read_file is exempt from the envelope again (see SELF_PAGINATED_TOOLS) —
// it bounds its own output and paginates via offset/limit on the source path
// (opencode parity), so the in-band head+tail envelope would only chop it
// mid-file. The envelope still backstops unbounded outputs (commands, etc.).
// v12 0.2: a screenshot's base64 PNG must reach toModelOutput intact (it
// becomes a media content part, not text tokens) — head/tail truncation would
// corrupt the image. v13.8: screenshots now arrive via browser_inspect
// (mode:"screenshot") as well as the legacy browser_screenshot tool, so we
// detect them by RESULT SHAPE (extractImageMedia) rather than tool name;
// browser_inspect's text/snapshot modes still truncate normally.
const NEVER_TRUNCATE = new Set<string>(["browser_screenshot"]);

// read_file bounds its own output (line/byte caps) and paginates cleanly via
// offset/limit on the source path, so it manages large files itself (opencode
// parity). Running it through the head+tail envelope would chop mid-file for no
// gain — exempt it; the envelope is for unbounded outputs (commands, etc.).
// read_attachment self-pages the same way since W3 (v14.8.11) — offset/limit
// over the cached full extraction, page size bounded in the tool itself.
const SELF_PAGINATED_TOOLS = new Set<string>(["read_file", "read_attachment"]);

/**
 * If `result` exceeds the token budget (or the byte ceiling) and the tool is
 * not exempt, return an IN-BAND head+tail preview plus a stateless hint on how
 * to see the rest. No disk spill: the model re-reads the original file via
 * offset/limit (read_file) or narrows the command — never a temp-file path.
 *
 * Renderer-safe: if Node modules are unavailable (browser bundle) the result is
 * returned untouched. The truncate/tokenizer helpers are imported lazily for
 * the same reason (they pull main-process settings into the module graph).
 */
export async function maybeTruncateToolOutput(
    toolName: string,
    result: unknown,
): Promise<{ value: unknown; truncated: boolean; totalChars: number }> {
    if (
        NEVER_TRUNCATE.has(toolName) ||
        SELF_PAGINATED_TOOLS.has(toolName) ||
        extractImageMedia(result)
    ) {
        return { value: result, truncated: false, totalChars: 0 };
    }
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    if (!resultStr || resultStr.length <= TOOL_OUTPUT_CHAR_FLOOR) {
        return { value: result, truncated: false, totalChars: resultStr?.length ?? 0 };
    }
    if (!isMainProcessNode()) {
        return { value: result, truncated: false, totalChars: resultStr.length };
    }

    try {
        const truncateLib = await import("@/lib/truncate");
        // Tokenize only mid-sized outputs; anything past the byte ceiling is
        // over budget by definition (≈4 chars/token).
        if (resultStr.length <= TOOL_OUTPUT_BYTE_CEILING) {
            const { estimateTokens } = await import("@/ipc/utils/token_utils");
            if (estimateTokens(resultStr) <= TOOL_OUTPUT_TOKEN_BUDGET) {
                return { value: result, truncated: false, totalChars: resultStr.length };
            }
        }

        const { text: preview, omittedChars } = truncateLib.headTailTruncateToTokens(
            resultStr,
            TOOL_OUTPUT_PREVIEW_HEAD_TOKENS,
            TOOL_OUTPUT_PREVIEW_TAIL_TOKENS,
        );
        const notice =
            `\n\n[output truncated: ${omittedChars.toLocaleString("en-US")} of ` +
            `${resultStr.length.toLocaleString("en-US")} chars omitted. To see more: ` +
            `for a file, call read_file again with offset/limit on the same path; ` +
            `for a command, narrow it (pipe through head/grep or target a specific path).]`;
        return {
            value: `${preview}${notice}`,
            truncated: true,
            totalChars: resultStr.length,
        };
    } catch {
        // If truncation fails (e.g. tokenizer unavailable), return the original.
        return { value: result, truncated: false, totalChars: resultStr.length };
    }
}

// ═══════════════════════════════════════════════════════════
// TOOL METADATA
// ═══════════════════════════════════════════════════════════
// v13: ToolCategory + per-tool `cost` removed — they were only consumed by the
// capability-trim stage (also removed). Tool inclusion is governed by the mode
// allowlist + workspace/core flags below.

export interface ToolMetadata {
    name: string;
    description: string;
    parameters: any;
    handler: (args: any, context?: any) => Promise<any>;
    requiresWorkspace?: boolean; // True if tool needs a workspace to function
    isCore?: boolean; // True if tool should be shown by default (with workspace)
    isReadOnly?: boolean; // True if tool only reads data (safe for Ask mode)
    /** When false isReadOnly: still offer in Ask mode (e.g. plan file writes with approval). */
    allowInAskMode?: boolean;
    /**
     * Former names this tool still answers to. Resolved by `get()` but NEVER
     * advertised: they don't appear in `getAll()`, any toolset, or any prompt.
     *
     * Renaming a tool otherwise breaks two things at once — persisted sessions whose
     * history contains the old name, and any model that learned it. Absorbing the old
     * name in the resolver fixes both without spending prompt budget telling the model
     * about a name it shouldn't use.
     */
    aliases?: string[];
}

// ═══════════════════════════════════════════════════════════
// TOOL REGISTRY
// ═══════════════════════════════════════════════════════════

export class ToolRegistry {
    private static tools: Map<string, ToolMetadata> = new Map();
    /**
     * Retired name → current name. Deliberately a SEPARATE map from `tools`: putting
     * aliases in there would make `getAll()` return the same tool twice, which every
     * toolset, the golden-toolset eval, and the registry audit read.
     */
    private static aliases: Map<string, string> = new Map();

    /**
     * Register a tool
     */
    static register(metadata: ToolMetadata): void {
        this.tools.set(metadata.name, metadata);
        for (const alias of metadata.aliases ?? []) {
            this.aliases.set(alias, metadata.name);
        }
    }

    /**
     * Get a tool by name, resolving a retired name to its current tool.
     */
    static get(name: string): ToolMetadata | undefined {
        const direct = this.tools.get(name);
        if (direct) return direct;
        const canonical = this.aliases.get(name);
        return canonical ? this.tools.get(canonical) : undefined;
    }

    /** The current name for a possibly-retired one (identity when not an alias). */
    static resolveName(name: string): string {
        return this.tools.has(name) ? name : (this.aliases.get(name) ?? name);
    }

    /**
     * Get all tools
     */
    static getAll(): ToolMetadata[] {
        return Array.from(this.tools.values());
    }

    /**
     * Get tools filtered by workspace context
     * @param hasWorkspace - Whether a workspace is active
     * @returns Appropriate tools for the context
     */
    static getToolsForContext(hasWorkspace: boolean): ToolMetadata[] {
        if (!hasWorkspace) {
            // Chat-only mode: only tools that don't require workspace
            return this.getAll().filter(
                (tool) => !tool.requiresWorkspace
            );
        } else {
            // Workspace (Build) mode: the whole context surface. resolve-toolset
            // narrows it, and tool-reveal.ts tiers the descriptions per mode.
            return this.getAll();
        }
    }

    /**
     * Get tools for Ask mode (read-only tools only)
     * Includes: read_file, glob, grep, web_search, read_url, etc.
     * Excludes: write_file, delete_file, run_command, code generation tools
     * @returns Read-only tools safe for Ask mode
     */
    static getToolsForAskMode(): ToolMetadata[] {
        return this.getAll().filter(
            (tool) => tool.isReadOnly === true || tool.allowInAskMode === true
        );
    }

    /**
     * Get tools for no-workspace (chat-only) mode: read-only only, no workspace required.
     * No file writes, no commands, no delegation. Code can be shown in responses but no write/run tools.
     */
    static getToolsForNoWorkspace(): ToolMetadata[] {
        return this.getAll().filter(
            (tool) => tool.isReadOnly === true && !tool.requiresWorkspace
        );
    }

    /**
     * Convert to AI SDK format
     */
    static toAISDKFormat(): Tool[] {
        return this.getAll().map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
    }

    /**
     * Convert filtered tools to AI SDK format
     * @param hasWorkspace - Whether a workspace is active
     */
    static toAISDKFormatForContext(hasWorkspace: boolean): Tool[] {
        return this.getToolsForContext(hasWorkspace).map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
    }

    /**
     * Execute a tool.
     *
     * - FIX 3 (graceful errors): missing required params return INVALID_PARAMS,
     *   thrown handler errors return TOOL_ERROR. No tool ever throws here.
     * - Permission gates (`__permission_required === true`) are returned
     *   unwrapped so the downstream interceptor in
     *   `permissions/interceptor.ts` can still detect them.
     */
    static async execute(
        name: string,
        args: any,
    ): Promise<any> {
        const tool = this.get(name);
        if (!tool) {
            return {
                success: false,
                error: "TOOL_ERROR",
                tool: name,
                message: `Tool not found: ${name}. Please try a different approach.`,
            };
        }

        return guardToolCall({
            toolName: name,
            args,
            parametersSchema: tool.parameters,
            // `runWith` receives the alias-canonicalised args (guard.ts), so a
            // model that sent `file_path` instead of `path` still reaches the
            // handler with the canonical key filled in.
            runWith: async (args: unknown) => {
                let raw: unknown;
                try {
                    raw = await tool.handler(args);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        success: false,
                        error: "TOOL_ERROR",
                        tool: name,
                        message: `Tool execution failed: ${message}`,
                        partial: null,
                        suggestion:
                            resolveRecoverySuggestion({ toolName: name, message }) ??
                            "Check parameters and workspace path. Use explore_folder or list_files to locate files.",
                    };
                }

                // If this is a permission request, return it directly (unwrapped)
                // so the interceptor can detect __permission_required flag.
                if (raw && typeof raw === "object" && (raw as { __permission_required?: boolean }).__permission_required) {
                    return raw;
                }

                // ask_user pause marker must also escape the success envelope —
                // the stream paths detect `__ask_user` at the TOP level to show
                // the question UI and block until the user answers. (This being
                // nested inside `{ success, result }` made the model receive the
                // raw marker and invent answers.)
                if (raw && typeof raw === "object" && (raw as { __ask_user?: boolean }).__ask_user === true) {
                    return raw;
                }

                // Treat as a failure when the tool says so explicitly
                // (success:false) OR returns a bare { error: "<msg>" } without a
                // success flag (the legacy edit_file/plan convention). v14.8.7 §F:
                // the latter previously slipped through as success:true with the
                // error nested in `result` — so the model saw a "successful" call
                // that had actually failed, and never got the recovery hint.
                if (isFailedToolResult(raw)) {
                    const fail = raw as {
                        error?: string;
                        message?: string;
                        suggestion?: string;
                        partial?: unknown;
                    };
                    const failMessage =
                        fail.message ?? fail.error ?? "Tool returned an error";
                    return {
                        success: false,
                        tool: name,
                        error: fail.error ?? "TOOL_ERROR",
                        message: failMessage,
                        partial: fail.partial ?? null,
                        ...fail,
                        // After the spread so a bare structured error still gains
                        // the per-tool recovery hint (model knows what to try next).
                        suggestion: resolveRecoverySuggestion({
                            toolName: name,
                            message: failMessage,
                            existingSuggestion: fail.suggestion,
                        }),
                    };
                }

                const truncation = await maybeTruncateToolOutput(name, raw);

                return {
                    success: true,
                    result: truncation.value,
                    _truncatedOutput: truncation.truncated,
                    _originalSize: truncation.truncated ? truncation.totalChars : undefined,
                };
            },
        });
    }

    /**
     * Clear all tools (for testing)
     */
    static clear(): void {
        this.tools.clear();
    }
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Create parameter schema for a tool
 */
export function createParameters(properties: Record<string, any>, required: string[] = []): any {
    return {
        type: "object",
        properties,
        required,
    };
}

/**
 * Create a simple string parameter
 */
export function stringParam(description: string): any {
    return {
        type: "string",
        description,
    };
}

/**
 * Create an array parameter
 */
export function arrayParam(itemType: string, description: string): any {
    return {
        type: "array",
        items: { type: itemType },
        description,
    };
}

/**
 * Create a boolean parameter
 */
export function booleanParam(description: string): any {
    return {
        type: "boolean",
        description,
    };
}

export function numberParam(
    nameOrDescription: string,
    requiredOrDefault?: boolean | number,
    defaultOrMin?: number,
    minOrMax?: number,
    max?: number,
): any {
    let name: string;
    let defaultValue: number | undefined;
    let min: number | undefined;
    let maxVal: number | undefined;

    if (typeof requiredOrDefault === "boolean") {
        name = nameOrDescription;
        defaultValue = defaultOrMin;
        min = minOrMax;
        maxVal = max;
    } else {
        name = nameOrDescription;
        defaultValue = requiredOrDefault;
        min = defaultOrMin;
        maxVal = minOrMax;
    }

    const param: any = { type: "number", description: name };
    if (defaultValue !== undefined) param.default = defaultValue;
    if (min !== undefined) param.minimum = min;
    if (maxVal !== undefined) param.maximum = maxVal;
    return param;
}

export function enumParam(
    nameOrDescription: string,
    requiredOrDefault?: boolean | string,
    defaultOrOptions?: string | string[],
    options?: string[],
): any {
    let name: string;
    let defaultValue: string | undefined;
    let opts: string[] | undefined;

    if (typeof requiredOrDefault === "boolean") {
        name = nameOrDescription;
        defaultValue = defaultOrOptions as string | undefined;
        opts = options;
    } else if (typeof requiredOrDefault === "string") {
        name = nameOrDescription;
        defaultValue = requiredOrDefault;
        opts = defaultOrOptions as string[] | undefined;
    } else {
        name = nameOrDescription;
        defaultValue = undefined;
        opts = requiredOrDefault as string[] | undefined;
    }

    const param: any = { type: "string", description: name };
    if (defaultValue !== undefined) param.default = defaultValue;
    if (opts) param.enum = opts;
    return param;
}
