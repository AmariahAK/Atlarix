/**
 * Atlarix Tool Registry
 * ====================
 * Central registry for all available tools
 */

import type { Tool } from "../providers/base-provider";
import { isMainProcessNode } from "../runtime/is-main-node";
import { guardToolCall } from "./guard";
import { resolveRecoverySuggestion } from "./tool-error-patterns";

// NOTE: this module is imported by both the Electron main process AND the renderer
// (e.g. `ToolIndicator.tsx` reads `ToolRegistry` for UI metadata). Anything that
// touches `node:*` must therefore be loaded lazily *inside* a function, never at
// module-top, AND guarded by `isMainProcessNode()` (not just `process.versions.node`,
// since Electron's renderer exposes that too). Otherwise Vite's browser bundle blows
// up with "Module 'node:crypto' has been externalized for browser compatibility".

// v10.1 token budgets: outputs whose ESTIMATED tokens exceed the budget (or
// whose raw size exceeds the byte ceiling) spill to disk; the model receives
// a head+tail preview instead of head-only — tails carry exit codes, error
// summaries, and final test results.
const TOOL_OUTPUT_BYTE_CEILING = 50_000;
/** Below this char count, never truncate (≈ well under the token budget) — skips tokenizing small outputs. */
const TOOL_OUTPUT_CHAR_FLOOR = 16_000;
const TOOL_OUTPUT_TOKEN_BUDGET = 6_000;
const TOOL_OUTPUT_PREVIEW_HEAD_TOKENS = 1_500;
const TOOL_OUTPUT_PREVIEW_TAIL_TOKENS = 500;
// PASS8 B3: All tools go through the standard disk-truncation envelope.
// Previously this exempted `read_file`, `get_blueprint`, and `get_active_skills`.
// Each of those is now bounded (read_file by request range, get_blueprint by the
// 300-line markdown cap added in B4, get_active_skills by its internal char cap),
// so the envelope is a safety net rather than a removed feature. Single global
// policy mirrors opencode's max-bytes envelope — no per-tool / per-tier carve-outs.
// v12 0.2: browser_screenshot's base64 PNG must reach toModelOutput intact
// (it becomes a media content part, not text tokens) — head/tail truncation
// would corrupt the image.
const NEVER_TRUNCATE = new Set<string>(["browser_screenshot"]);

let _toolOutputDirPath: string | null = null;
let _toolOutputDirReady = false;

async function ensureToolOutputDir(): Promise<string | null> {
    if (!isMainProcessNode()) return null;
    if (_toolOutputDirReady && _toolOutputDirPath) return _toolOutputDirPath;
    try {
        const [{ default: os }, { default: path }, fs] = await Promise.all([
            import("node:os"),
            import("node:path"),
            import("node:fs/promises"),
        ]);
        const dir = path.join(os.tmpdir(), "atlarix-tool-outputs");
        await fs.mkdir(dir, { recursive: true });
        _toolOutputDirPath = dir;
        _toolOutputDirReady = true;
        return dir;
    } catch {
        // Best-effort; we'll re-try next call if it failed.
        return null;
    }
}

/**
 * If `result` exceeds the token budget (or the byte ceiling) and the tool is
 * not in NEVER_TRUNCATE, write the full payload to a tmp file and return a
 * `{ preview, diskPath, totalChars }` envelope with a head+tail preview.
 * Otherwise return the original result unchanged.
 *
 * Renderer-safe: if Node modules are unavailable (browser bundle) the result is
 * returned untouched. The truncate/tokenizer helpers are imported lazily for
 * the same reason (they pull main-process settings into the module graph).
 */
export async function maybeTruncateToDisk(
    toolName: string,
    result: unknown,
): Promise<{ value: unknown; truncated: boolean; totalChars: number }> {
    if (NEVER_TRUNCATE.has(toolName)) {
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

        const dir = await ensureToolOutputDir();
        if (!dir) {
            return { value: result, truncated: false, totalChars: resultStr.length };
        }
        const [{ default: path }, fs, crypto] = await Promise.all([
            import("node:path"),
            import("node:fs/promises"),
            import("node:crypto"),
        ]);
        const id = crypto.randomBytes(4).toString("hex");
        const diskPath = path.join(dir, `${toolName}-${id}.txt`);
        await fs.writeFile(diskPath, resultStr, "utf-8");
        const { text: preview, omittedChars } = truncateLib.headTailTruncateToTokens(
            resultStr,
            TOOL_OUTPUT_PREVIEW_HEAD_TOKENS,
            TOOL_OUTPUT_PREVIEW_TAIL_TOKENS,
        );
        return {
            value: {
                truncated: true,
                totalChars: resultStr.length,
                preview,
                diskPath,
                message: `Output exceeded the ${TOOL_OUTPUT_TOKEN_BUDGET}-token budget — showing head + tail (${omittedChars.toLocaleString("en-US")} chars omitted). Full output written to ${diskPath}. Use read_file with this exact absolute path (offset/limit supported) to read the spill file.`,
            },
            truncated: true,
            totalChars: resultStr.length,
        };
    } catch {
        // If we can't write the file, fall back to returning the original result.
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
}

// ═══════════════════════════════════════════════════════════
// TOOL REGISTRY
// ═══════════════════════════════════════════════════════════

export class ToolRegistry {
    private static tools: Map<string, ToolMetadata> = new Map();

    /**
     * Register a tool
     */
    static register(metadata: ToolMetadata): void {
        this.tools.set(metadata.name, metadata);
    }

    /**
     * Get a tool by name
     */
    static get(name: string): ToolMetadata | undefined {
        return this.tools.get(name);
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
            // Workspace (Build) mode: return all tools for manifest; progressive reveal
            // filters to loaded+core in chat_stream_handlers when building the tools object
            return this.getAll();
        }
    }

    /**
     * Get tools for Ask mode (read-only tools only)
     * Includes: read_file, list_files, search_code, web_search, get_diagram, git_log, etc.
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
     * Get all optional workspace tools (for dynamic loading)
     * @returns Tools that can be requested via request_tools
     */
    static getOptionalWorkspaceTools(): ToolMetadata[] {
        return this.getAll().filter(
            (tool) => tool.requiresWorkspace && !tool.isCore
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
            runner: async () => {
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

                if (
                    raw &&
                    typeof raw === "object" &&
                    !Array.isArray(raw) &&
                    (raw as { success?: boolean }).success === false
                ) {
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

                const truncation = await maybeTruncateToDisk(name, raw);

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
