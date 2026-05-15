/**
 * Atlarix System Prompt
 * ======================
 * Minimal system prompt that loads AGENTS.md as the primary guidance.
 * v2.1: Supports project instruction precedence (ATLARIX.md, workspace, global, bundle).
 *
 * - AGENTS.md: Full reference (55 tools) for 32K+ models
 * - AGENTS_COMPACT.md: Essential guidance (~100 lines) for 8K models
 */

import path from "node:path";
import fs from "node:fs";
import log from "electron-log";
import {
  loadInstructionLayers,
  buildInstructionsFromLayers,
} from "../lib/project-instructions";

const logger = log.scope("system_prompt");

/** Injected into system prompt so the model can answer "what version" / who built Atlarix accurately */
function getElectronAppVersion(): string {
    try {
        const electron = require("electron") as { app?: { getVersion?: () => string } };
        if (electron.app?.getVersion) {
            return electron.app.getVersion();
        }
    } catch {
        /* not in Electron */
    }
    return "unknown";
}

// ═══════════════════════════════════════════════════════════
// AGENTS.MD LOADING
// ═══════════════════════════════════════════════════════════

let AGENTS_MD_FULL = "";
let AGENTS_MD_COMPACT = "";

const loadAgentsFile = (filename: string): string => {
    const paths: string[] = [
        path.join(process.cwd(), filename),
        path.join(__dirname, "../../", filename),
        path.join(__dirname, "../../../", filename),
    ];
    // Packaged Electron: app lives in app.asar; getAppPath() points to app root so files are found
    try {
        const { app } = require("electron");
        if (app && typeof app.getAppPath === "function") {
            paths.unshift(path.join(app.getAppPath(), filename));
        }
    } catch {
        // not in Electron or app not ready
    }

    for (const p of paths) {
        try {
            if (fs.existsSync(p)) {
                const content = fs.readFileSync(p, "utf-8");
                logger.info(`Loaded ${filename} from ${p} (${content.length} bytes)`);
                return content;
            }
        } catch {
            /* try next */
        }
    }

    logger.warn(`${filename} not found`);
    return "";
};

// Load at startup
AGENTS_MD_FULL = loadAgentsFile("AGENTS.md");
AGENTS_MD_COMPACT = loadAgentsFile("AGENTS_COMPACT.md");

// Fallback if both failed (e.g. packaged app layout): minimal prompt so app never runs with empty
const FALLBACK_AGENTS = `# Atlarix
You are Atlarix, an AI development assistant. Use tools for operations.
Use run_command with cwd for working directory. For scaffolding run exactly one run_command.
`;

if (!AGENTS_MD_FULL && !AGENTS_MD_COMPACT) {
    logger.error("AGENTS.md and AGENTS_COMPACT.md not found; using fallback minimal prompt");
    AGENTS_MD_FULL = FALLBACK_AGENTS;
    AGENTS_MD_COMPACT = FALLBACK_AGENTS;
}

/**
 * Get AGENTS.md content based on model context size.
 * PASS8 A1: Always prefer AGENTS_COMPACT.md regardless of context size. The full
 * AGENTS.md is kept only as a fallback for the rare case the compact file is missing.
 * Every token in this base layer costs a token on every single dispatch.
 */
export const getAgentsMdForContextSize = (_contextSize: number = 32000): string => {
    return AGENTS_MD_COMPACT || AGENTS_MD_FULL || "";
};

// ═══════════════════════════════════════════════════════════
// BUILD SYSTEM SENTINELS (e2e snapshot normalization)
// ═══════════════════════════════════════════════════════════

/** Sentinel string that starts the build/system instruction block in the prompt. Replaced in e2e with "\n${BUILD_SYSTEM_PREFIX}" for stable snapshots. */
export const BUILD_SYSTEM_PREFIX = "\n---\n";
/** Sentinel string that ends the build/system instruction block. Replaced in e2e with "${BUILD_SYSTEM_POSTFIX}" for stable snapshots. */
export const BUILD_SYSTEM_POSTFIX = "\n---\n";

// ═══════════════════════════════════════════════════════════
// PASS 7 — MODE SYSTEM DECLARATION
// ═══════════════════════════════════════════════════════════
// Tool lists below MUST stay in sync with `modeAllowlist` in
// `src/ipc/handlers/chat_stream_handlers.ts`. A smoke test asserts this.
// Order: each set is sorted alphabetically.

export const MODE_SYSTEM_TOOL_LISTS = {
  // PASS8 B2: get_workspace_overview removed — referenced in prose but never
  // registered in src/lib/tools/. The mode_system_consistency test asserts these
  // lists mirror modeAllowlist in chat_stream_handlers.ts exactly.
  ask: [
    "ask_user",
    "clear_blueprint",
    "compress_context",
    "deep_research",
    "explore_folder",
    "find_file",
    "get_active_skills",
    "get_blueprint",
    "get_diagram",
    "get_file_outline",
    "get_project_history",
    "get_project_structure",
    "get_repo_overview",
    "git_diff",
    "git_log",
    "git_status",
    "list_attachments",
    "list_available_mcps",
    "list_files",
    "list_installed_skills",
    "memory",
    "read_attachment",
    "read_file",
    "read_url",
    "request_mode_change",
    "search",
    "set_blueprint",
    "web_search",
  ],
  plan: [
    "ask_user",
    "clear_blueprint",
    "compress_context",
    "edit_file",
    "explore_folder",
    "find_file",
    "get_active_skills",
    "get_blueprint",
    "get_diagram",
    "get_file_outline",
    "get_plan_scope",
    "get_project_history",
    "get_project_structure",
    "get_repo_overview",
    "list_available_mcps",
    "list_files",
    "list_installed_skills",
    "memory",
    "read_file",
    "read_implementation_plan",
    "request_mode_change",
    "search",
    "set_blueprint",
    "write_file",
    "write_implementation_plan",
  ],
  build: ["*"],
  debug: [
    "ask_user",
    "clear_blueprint",
    "diagnose_issue",
    "edit_file",
    "explore_folder",
    "find_file",
    "get_active_skills",
    "get_blueprint",
    "get_diagram",
    "get_file_outline",
    "get_project_structure",
    "get_repo_overview",
    "git_diff",
    "git_log",
    "git_status",
    "list_available_mcps",
    "list_files",
    "lsp_definitions",
    "lsp_diagnostics",
    "lsp_hover",
    "lsp_references",
    "mcp_call",
    "memory",
    "read_file",
    "request_mode_change",
    "run_command",
    "search",
    "set_blueprint",
    "stream_terminal_output",
  ],
  review: [
    "ask_user",
    "clear_blueprint",
    "diagnose_issue",
    "explore_folder",
    "find_file",
    "get_active_skills",
    "get_blueprint",
    "get_diagram",
    "get_file_outline",
    "get_project_history",
    "get_project_structure",
    "get_repo_overview",
    "git_diff",
    "git_log",
    "git_status",
    "list_available_mcps",
    "list_files",
    "list_installed_skills",
    "lsp_definitions",
    "lsp_diagnostics",
    "lsp_hover",
    "lsp_references",
    "memory",
    "read_file",
    "request_mode_change",
    "search",
    "set_blueprint",
  ],
} as const;

export type ModeSystemKey = keyof typeof MODE_SYSTEM_TOOL_LISTS;

const MODE_SYSTEM_DESCRIPTIONS: Record<ModeSystemKey, string> = {
  ask: "Read-only exploration. Answer questions, summarise code, and never mutate the workspace.",
  plan: "Author .atlarix/ATLARIX_PLAN.md (and other plan/markdown files) before any production code change.",
  build: "Full implementation surface. All registered tools are available; respect approval flows for writes / commands.",
  debug: "Investigate and fix bugs. Read tools + diagnose_issue + run_command + edit_file. After substantive edits, call **lsp_diagnostics** on touched files before claiming success.",
  review: "Read-only review. Inspect changes, surface findings; do not mutate files. Use **lsp_diagnostics** / **lsp_hover** when IDE-grade signals help.",
};

/**
 * Render `<mode_system>` block — declares which tools are available per work mode.
 * Pass 7: replaces ad-hoc descriptions with a structured, machine-checkable list.
 * PASS8 A2: When `activeMode` is provided, only that mode's block is emitted (the
 * other four modes were ~150 tokens of dead context per dispatch). When omitted,
 * all five blocks render — used by token_count_handlers and other static callers
 * that do not know the live work mode at call time.
 */
export function renderModeSystemBlock(activeMode?: ModeSystemKey): string {
  const lines: string[] = [];
  lines.push("<mode_system>");
  lines.push("Each work mode exposes a fixed tool surface. Mode-switch via request_mode_change.");
  lines.push("Tools registered in EVERY mode (also chat-only): read_attachment, list_attachments, compress_context, web_search, deep_research, ask_user.");
  lines.push("");
  const modesToEmit: ModeSystemKey[] = activeMode
    ? [activeMode]
    : (Object.keys(MODE_SYSTEM_TOOL_LISTS) as ModeSystemKey[]);
  for (const mode of modesToEmit) {
    const tools = MODE_SYSTEM_TOOL_LISTS[mode];
    const display = tools[0] === "*" ? "ALL registered tools" : tools.join(", ");
    lines.push(`- **${mode}** — ${MODE_SYSTEM_DESCRIPTIONS[mode]}`);
    lines.push(`  tools: ${display}`);
  }
  lines.push("");
  lines.push("If you need a tool outside the current mode's surface, call request_mode_change with a brief reason.");
  lines.push("</mode_system>");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCT SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════

export interface ConstructSystemPromptParams {
    chatMode?: "build" | "ask";
    /**
     * PASS8 A2: When set, only this mode's block is emitted inside `<mode_system>`.
     * Stream-side callers thread the live work mode through; static callers (e.g.
     * token_count IPC) omit it and get the legacy all-five-modes rendering.
     */
    effectiveWorkMode?: ModeSystemKey;
    userPrompt?: string | null;
    contextSize?: number;
    /** v2.1: When set, use as base (project instruction precedence already applied). */
    optionalProjectInstructions?: string;
    /** Legacy: unused in builder, kept for call-site compatibility. */
    enableTurboEditsV2?: boolean;
    /** v3.9: When true, omit the <questions> clarifying-questions instruction (user already answered). */
    hasAnsweredQuestions?: boolean;
}

/**
 * PASS8 A5: Two-part system payload for streamText.
 *  - `stableHeader` is cache-friendly: identity, tool_contract, active-mode block,
 *    mode-specific instruction, web-research rules, runtime identity. Stable across
 *    turns within a session for a given chatMode + effectiveWorkMode.
 *  - `dynamicTail` carries per-turn content: current date/time, user_context block,
 *    clarifying-questions block. Caller appends ContextAssembler additions as well.
 *
 * Modeled on packages/opencode/src/session/llm.ts (system: string[]) but adapted to
 * the AI SDK shape — see chat_stream_handlers.ts where the header is passed as the
 * `system` field and the tail is prepended as a system-role message in `messages`.
 */
export interface SystemPromptParts {
    stableHeader: string;
    dynamicTail: string;
}

const buildModeSpecificInstruction = (chatMode: "build" | "ask"): string => {
    if (chatMode === "ask") {
        return `
---

# Mode: Ask (Read-only exploration)

You are in **Ask mode**: answer questions and explore the workspace with **read-only** tools only.

**Default:** For questions, explanations, and code understanding — answer directly using read_file, explore_folder, search, list_files, and either \`web_search\` **or** \`deep_research\` (never both for the same topic in one turn), plus analysis tools as needed.

read_attachment({ "attachmentId": "<id>" }) and list_attachments({}) ARE available in Ask
mode and in every other mode. Use them whenever the user has attached a file, regardless of
whether a workspace is open.

**Roadmaps and plan files:** Do **not** write **.atlarix/ATLARIX_PLAN.md** or use \`write_implementation_plan\` in Ask mode. For structured implementation plans or phased roadmaps, direct the user to **Plan** mode (or use \`request_mode_change\` toward plan). Suggest **Build** only when they are done planning and want code execution—not for ordinary exploration.

**Deterministic discovery flow:**
1. **Explore target folders:** Call \`explore_folder\` (and \`list_files\` if needed) on the **specific** paths tied to the question. For a repo “map at a glance”, use \`get_repo_overview\` with \`focus_path\` set to the subfolder you care about (monorepos / huge trees). Avoid \`get_repo_overview\` at the workspace root when only a package or app matters.
2. **Deep-dive precisely:** Use \`search\` (mode: auto | text | semantic | structural) and \`get_file_outline\`, then \`read_file\` only for the exact ranges you need.
3. **Architecture:** Call \`get_blueprint\` (optionally \`include_panel_graph: true\`) or \`get_diagram\` when you need an explicit structural map. To show a curated slice in the Diagram tab mind map, call \`set_blueprint\` with the **current best** graph (it **replaces** the prior panel state—do not accumulate). Use \`clear_blueprint\` when the panel should be emptied.

**CRITICAL RULES:**
- Do NOT use \`write_file\`, \`write_implementation_plan\`, \`replace_code\`, \`run_command\`, or other mutating tools.
`;
    }
    return `
---

# Mode: Build

Use function-calling tools for ALL operations. Never describe what you would do.

**Deterministic discovery flow (Build):**
1. **Explore target folders:** Call \`explore_folder\` / \`list_files\` to verify exact paths before edits.
2. **Deep-dive precisely:** Use \`search\` (mode: auto | text | semantic | structural) and \`get_file_outline\`; read only the necessary files/snippets via \`read_file\`.
3. **Architecture:** Call \`get_blueprint\` (optionally \`include_panel_graph: true\`) or \`get_diagram\` when you need an explicit structural map. To show a curated slice in the Diagram tab mind map, call \`set_blueprint\` with the **current best** graph (it **replaces** the prior panel state—do not accumulate). Use \`clear_blueprint\` when the panel should be emptied.

If architecture context is missing, obtain it before changing code.

**Scaffolding:** For project scaffolding (e.g. create-vite), run exactly one run_command that creates the project; do not emit multiple create/scaffold commands in the same turn.

## Task Completion Signal
When you have FULLY completed a task and ALL features work:
1. Test that everything actually works
2. Output EXACTLY: <task_complete>Task finished successfully</task_complete>

Use <task_complete> when:
- Created all requested files and they compile/run without errors
- All tests pass
- All features work as described

Do NOT use <task_complete> if:
- Waiting for user approval of file changes
- Encountered an error that blocks progress
- Need more information from the user
- Tests are failing or code has syntax errors

If unsure, do NOT output <task_complete>. It's better to continue than stop prematurely.
`;
};

/**
 * PASS8 A5: Construct the stable + dynamic parts of the system prompt.
 * Used by stream handlers to pass `stableHeader` as `system:` and prepend
 * `dynamicTail` as a system-role message in `messages` for cache friendliness.
 */
export const constructSystemPromptParts = ({
    chatMode = "build",
    effectiveWorkMode,
    userPrompt,
    contextSize = 32000,
    optionalProjectInstructions,
    hasAnsweredQuestions = false,
}: ConstructSystemPromptParams): SystemPromptParts => {
    const base = optionalProjectInstructions ?? getAgentsMdForContextSize(contextSize);

    // PASS8 A3: <tool_contract> slimmed to the contract itself; verbose prose dropped.
    const toolContract = `<tool_contract>
Every-mode tools: read_attachment, list_attachments, compress_context, web_search, deep_research, ask_user.
Workspace-only tools (file read/write, search, diagram, etc.) are NOT available in chat-only mode.
If a tool is in your tool list, call it; do not claim it is missing.
Optional caps (max_bytes, max_lines, timeout_ms, max_output_bytes, etc.) are tuning knobs—use higher values only when the default would block legitimate work.
</tool_contract>`;

    const webResearchRules = `**Web research tools — pick exactly one per topic per turn**

You have \`web_search\` and \`deep_research\`. **RULE:** For any single research topic or question in one assistant turn, use **one** of these two only. **Never** call both for the same subject or overlapping topic in the same turn.

- **web_search** (quick mode): simple facts, version checks, error strings, narrow single-query lookups, "what is X".
- **deep_research**: complex topics needing multiple angles, comparisons, market-style research, or analysis that clearly needs several sources. It runs internal searches—**do not** add \`web_search\` afterward for the same or a paraphrased topic; synthesize from \`deep_research\` results only.
- **read_url**: when the user gives a specific URL to open—use \`read_url\`, not a blanket web_search on top of deep_research.

If you already called \`deep_research\`, your next step is to answer from its structured output, not to supplement with \`web_search\`.`;

    const modeBlock = renderModeSystemBlock(effectiveWorkMode);
    const modeSpecific = buildModeSpecificInstruction(chatMode);
    const appVersion = getElectronAppVersion();
    const runtimeIdentity = `# Atlarix runtime identity
You run inside the **Atlarix** desktop app by **NorahLabs** (norahlabs.com). Product: atlarix.dev.
- **App version:** \`${appVersion}\`
- If asked who made Atlarix, what you are, what version you or the app are, or similar: you are the **Atlarix** in-app assistant; **NorahLabs** builds Atlarix; state the app version exactly as **${appVersion}**. Do not say you have no version, or that you were created by an unnamed "development team."`;

    const stableHeader = [
        base.trim(),
        toolContract,
        modeBlock,
        webResearchRules,
        modeSpecific.trim(),
        runtimeIdentity,
    ].filter((s) => s.length > 0).join("\n\n");

    // Dynamic tail: contents that vary per turn.
    const currentDateTime = new Date().toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    });
    let tail = `# Current date and time
Today is ${currentDateTime}. Use this date when answering questions about "today", "current", or "latest", and when using web_search for time-sensitive queries.`;

    if (userPrompt && userPrompt.trim().length > 0) {
        tail += `\n\n<user_context>\n${userPrompt.trim()}\n</user_context>`;
    }
    if (!hasAnsweredQuestions) {
        tail += `\n\n# Clarifying questions
If a task is ambiguous in ways that produce fundamentally different outcomes — architecture decisions, destructive ops, unclear scope — emit ONE <questions> block before responding (max 4 questions, 4 choices each). Do NOT use for cosmetic details. After user answers, proceed directly without asking again.`;
    }

    return { stableHeader, dynamicTail: tail };
};

/**
 * Backwards-compatible joiner — returns the single-string system prompt that
 * callers expecting a string still consume (token-count IPC, legacy paths).
 * Stream handlers should prefer `constructSystemPromptParts` and pass header + tail
 * separately to streamText for prompt-cache friendliness.
 */
export const constructSystemPrompt = (params: ConstructSystemPromptParams): string => {
    const { stableHeader, dynamicTail } = constructSystemPromptParts(params);
    return `${stableHeader}\n\n${dynamicTail}\n`;
};

/**
 * v2.1: Build system prompt with project instruction precedence (ATLARIX.md, workspace, global, bundle).
 * Use when workspacePath is available for full layer loading.
 * PASS8 A2: Accepts `effectiveWorkMode` so the active-mode-only `<mode_system>` rendering
 * is threaded through this convenience wrapper.
 */
export async function buildSystemPromptWithProjectInstructions(params: {
    workspacePath: string;
    workspacePromptContent: string | null;
    contextSize: number;
    chatMode: "build" | "ask";
    effectiveWorkMode?: ModeSystemKey;
    userPrompt?: string | null;
    /** v3.9: When true, omit the <questions> instruction. */
    hasAnsweredQuestions?: boolean;
}): Promise<string> {
    const { workspacePath, workspacePromptContent, contextSize, chatMode, effectiveWorkMode, userPrompt, hasAnsweredQuestions } = params;
    const bundleContent = getAgentsMdForContextSize(contextSize);
    const layers = await loadInstructionLayers({
        workspacePath,
        workspacePromptContent,
        bundleAgentsContent: bundleContent,
    });
    const optionalProjectInstructions = buildInstructionsFromLayers(layers);
    return constructSystemPrompt({
        contextSize,
        chatMode,
        effectiveWorkMode,
        userPrompt,
        optionalProjectInstructions,
        hasAnsweredQuestions,
    });
}

/**
 * PASS8 A2 + A5: Same as `buildSystemPromptWithProjectInstructions` but returns the
 * stable header / dynamic tail split for stream handlers that want prompt-cache friendliness.
 */
export async function buildSystemPromptPartsWithProjectInstructions(params: {
    workspacePath: string;
    workspacePromptContent: string | null;
    contextSize: number;
    chatMode: "build" | "ask";
    effectiveWorkMode?: ModeSystemKey;
    userPrompt?: string | null;
    hasAnsweredQuestions?: boolean;
}): Promise<SystemPromptParts> {
    const { workspacePath, workspacePromptContent, contextSize, chatMode, effectiveWorkMode, userPrompt, hasAnsweredQuestions } = params;
    const bundleContent = getAgentsMdForContextSize(contextSize);
    const layers = await loadInstructionLayers({
        workspacePath,
        workspacePromptContent,
        bundleAgentsContent: bundleContent,
    });
    const optionalProjectInstructions = buildInstructionsFromLayers(layers);
    return constructSystemPromptParts({
        contextSize,
        chatMode,
        effectiveWorkMode,
        userPrompt,
        optionalProjectInstructions,
        hasAnsweredQuestions,
    });
}

