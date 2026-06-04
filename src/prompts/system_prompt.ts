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
import {
  buildWorkstationIdentityBlock,
  resolveActiveModelIdentity,
} from "../lib/model-identity-prompt";
import type { LargeLanguageModel } from "../lib/schemas";
import { loadVisualArtifactsGuide } from "../lib/skills/builtin-guides";
import {
    MODE_SYSTEM_TOOL_LISTS,
    type ModeRegistryKey,
} from "../lib/tools/mode-tool-registry";
import {
    renderModePromptBundle,
    GIT_VIA_TERMINAL_NOTE,
    modeAllowlistIncludesWebResearch,
    modeAllowlistIncludesVisualTools,
} from "../lib/tools/mode-prompt-bundle";
import { getAppVersion } from "../lib/app-version";
import { gitAuthorNameForModel } from "../ipc/utils/git_author";
import { buildProjectDocsPromptHint } from "../lib/project-memory";

/** Modes whose write tools may create/update the .atlarix doc files. */
function canWriteProjectDocs(mode?: ModeSystemKey): boolean {
    return mode === "plan" || mode === "build" || mode === "debug";
}

const logger = log.scope("system_prompt");

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
const AGENTS_MD_MODE_BASE = loadAgentsFile("AGENTS_MODE_BASE.md");

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
export { MODE_SYSTEM_TOOL_LISTS };
export type ModeSystemKey = ModeRegistryKey;

/** Mode-scoped bundle — omits multi-mode summaries (active mode is in `<mode_system>` only). */
export const getAgentsMdForWorkMode = (_mode: ModeSystemKey): string => {
    return AGENTS_MD_MODE_BASE || AGENTS_MD_COMPACT || AGENTS_MD_FULL || "";
};

const MODE_SYSTEM_DESCRIPTIONS: Record<ModeSystemKey, string> = {
  ask: "Explore (read-only). Answer questions, summarise code, and never mutate the workspace.",
  plan: "Author session plan artifacts (write_implementation_plan) and .atlarix/atlarix.md before production code changes.",
  build: "Full implementation surface. All registered tools are available; respect approval flows for writes / commands.",
  debug: "Debug mode — hypothesis-first fixes. Call **record_debug_hypothesis** before write_file, edit_file, delete_file, rename_file, or write_multiple_files; apply minimal changes that test the hypothesis. Prefer **lsp_diagnostics** after edits; use **diagnose_issue** for runtime/tooling signals.",
  review: "Read-only review. Inspect changes, surface findings; do not mutate files. Use **lsp_diagnostics** / **lsp_hover** when IDE-grade signals help.",
};

export { GIT_VIA_TERMINAL_NOTE };

/**
 * Legacy all-modes block — avoid for live streams; pass effectiveWorkMode instead.
 * Only non-model-facing callers (e.g. token estimation) may omit the mode.
 */
export function renderModeSystemBlock(activeMode?: ModeSystemKey): string {
  if (activeMode) {
    return renderModePromptBundle(activeMode);
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[system_prompt] renderModeSystemBlock(undefined) renders ALL modes — never use for live streams",
    );
  }
  const lines: string[] = [];
  lines.push("<mode_system>");
  lines.push("Tools registered in EVERY mode: read_attachment, list_attachments, compress_context, web_search, deep_research, ask_user.");
  lines.push("");
  for (const mode of Object.keys(MODE_SYSTEM_TOOL_LISTS) as ModeSystemKey[]) {
    const tools = MODE_SYSTEM_TOOL_LISTS[mode];
    const display = tools[0] === "*" ? "ALL registered tools" : tools.join(", ");
    lines.push(`- **${mode}** — ${MODE_SYSTEM_DESCRIPTIONS[mode]}`);
    lines.push(`  tools: ${display}`);
  }
  lines.push("");
  lines.push(GIT_VIA_TERMINAL_NOTE);
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
    /** @deprecated Legacy flag; clarifying `<questions>` blocks are no longer used. */
    hasAnsweredQuestions?: boolean;
    /** Resolved model for this turn (after Auto routing). Drives workstation identity block. */
    activeModel?: LargeLanguageModel;
    modelDisplayName?: string;
    providerBrand?: string;
    labelWithProvider?: string;
    /** Loaded native tool names for progressive-reveal registry split. */
    registeredToolNames?: readonly string[];
    /** When true, workspace MCP/skills lines are appended to tools_registry. */
    hasWorkspace?: boolean;
}

/**
 * PASS8 A5: Two-part system payload for streamText.
 *  - `stableHeader` is cache-friendly: identity, tool_contract, active-mode block,
 *    mode-specific instruction, web-research rules, runtime identity. Stable across
 *    turns within a session for a given chatMode + effectiveWorkMode.
 *  - `dynamicTail` carries per-turn content: current date/time, user_context block,
 *    per-turn tail (date, user_context, ask_user guidance). Caller appends ContextAssembler additions as well.
 *
 * Modeled on packages/opencode/src/session/llm.ts (system: string[]) but adapted to
 * the AI SDK shape — see chat_stream_handlers.ts where the header is passed as the
 * `system` field and the tail is prepended as a system-role message in `messages`.
 */
export interface SystemPromptParts {
    stableHeader: string;
    dynamicTail: string;
}

/** Discovery steps shared by Ask + Build (kept in one place — they ship on every dispatch). */
const DISCOVERY_DEEP_DIVE = `**Deep-dive precisely:** Use \`search\` (mode: auto | text | semantic | structural) and \`get_file_outline\`, then \`read_file\` only for the exact ranges you need.`;
const DISCOVERY_ARCHITECTURE = `**Architecture:** Call \`get_blueprint\` when you need a structural map. **\`get_blueprint\` always requires \`focus_path\`** (one folder section). When a visual clearly helps, **include the fence in the same reply**—do not wait for the user to ask for a diagram. After \`explore_folder\` / \`get_repo_overview\` summarizing structure, prefer **one** \`\`\`markmap\`\`\` unless they asked for a flow. After tracing a bug or API call chain, prefer **one** \`\`\`graph\`\`\` JSON diagram (nodes + edges) or \`visualize_graph\`.`;

/** Per work-mode instruction block (replaces ask/build-only `buildModeSpecificInstruction`). */
export const buildWorkModeInstruction = (workMode: ModeSystemKey): string => {
    if (workMode === "ask") {
        return `
---

# Mode: Explore (read-only)

You are in **Ask mode**: answer questions and explore the workspace with **read-only** tools only.

**Default:** For questions, explanations, and code understanding — answer directly using read_file, explore_folder, search, list_files, and either \`web_search\` **or** \`deep_research\` (never both for the same topic in one turn), plus analysis tools as needed.

read_attachment({ "attachmentId": "<id>" }) and list_attachments({}) ARE available in Ask
mode and in every other mode. Use them whenever the user has attached a file, regardless of
whether a workspace is open.

**Roadmaps and plans:** Do **not** use \`write_implementation_plan\` in Ask mode. For structured implementation plans or phased roadmaps, direct the user to **Plan** mode in the UI. Suggest **Build** only when they are done planning and want code execution—not for ordinary exploration.

**Deterministic discovery flow:**
1. **Explore target folders:** Call \`explore_folder\` (and \`list_files\` if needed) on the **specific** paths tied to the question. For a repo “map at a glance”, use \`get_repo_overview\` with \`focus_path\` set to the subfolder you care about (monorepos / huge trees). Avoid \`get_repo_overview\` at the workspace root when only a package or app matters.
2. **Multi-repo / monorepo:** Use at most **5** \`spawn_sub_agent\` calls per turn. Batch paths via \`scopes\` when one agent can cover several repos. Prefer **explore** + preset **map_repo** (or **reviewer** in Review) instead of many bare parallel explore tools.
3. ${DISCOVERY_DEEP_DIVE}
4. ${DISCOVERY_ARCHITECTURE}

**CRITICAL RULES:**
- Do NOT use \`write_file\`, \`write_implementation_plan\`, \`replace_code\`, \`run_command\`, or other mutating tools.
`;
    }
    if (workMode === "plan") {
        return `
---

# Mode: Plan

You are in **Plan** mode: read-only exploration plus session plan artifacts and \`.atlarix/atlarix.md\`.

- Use \`write_implementation_plan\` / \`read_implementation_plan\` / \`update_plan_status\` for roadmaps (DB session artifacts, not files).
- Use \`write_file\` / \`edit_file\` only for \`.atlarix/atlarix.md\`.
- Do NOT edit application source code or run build/install commands.
- When implementation is requested, tell the user to switch to **Build** in the UI.
`;
    }
    if (workMode === "debug") {
        return `
---

# Mode: Debug

You are in **Debug** mode: hypothesis-first debugging with gated write tools.

1. Investigate (read, search, LSP, \`diagnose_issue\`, \`run_command\` for repro).
2. Call **record_debug_hypothesis** with a clear root-cause hypothesis and likely files.
3. Apply **minimal** \`edit_file\` / \`write_file\` / \`delete_file\` / \`rename_file\` changes that test only that hypothesis.
4. Verify with **lsp_diagnostics** and targeted tests; revise the hypothesis if evidence contradicts it.

Do not write or edit source files before step 2.
`;
    }
    if (workMode === "review") {
        return `
---

# Mode: Review

You are in **Review** mode: read-only quality and security review.

- Do NOT write source files or run mutating commands.
- Produce specific, actionable feedback.
`;
    }
    return `
---

# Mode: Build

Use function-calling tools for ALL operations. Never describe what you would do.

- **Project files** (source, configs, task folders, README) belong at the **workspace project root**, not under \`.atlarix/\`.
- \`.atlarix/\` is for session metadata and plan docs only unless the user explicitly asks otherwise.

**Deterministic discovery flow (Build):**
1. **Explore target folders:** Call \`explore_folder\` / \`list_files\` to verify exact paths before edits.
2. ${DISCOVERY_DEEP_DIVE}
3. ${DISCOVERY_ARCHITECTURE}

If architecture context is missing, obtain it before changing code.

After **edit_file** or **write_file**, call **lsp_diagnostics** on touched paths when a language server is available — prefer LSP over ad-hoc TypeScript-only checks for claiming the change is clean.

**Scaffolding:** For project scaffolding (e.g. create-vite), run exactly one run_command that creates the project; do not emit multiple create/scaffold commands in the same turn.

**Large files:** Prefer \`write_file\` payloads under ~500 lines per call. For large specs or task docs, split across multiple files or use \`write_multiple_files\`. Do not stream multi-thousand-line documents in a single tool call.

## Task Completion Signal
Only after verifying everything works (files compile/run, tests pass), output EXACTLY:
<task_complete>Task finished successfully</task_complete>
Do NOT emit it while waiting on approvals, blocked on errors/failing tests, or needing user input. If unsure, keep working instead of stopping prematurely.
`;
};

/**
 * PASS8 A5: Construct the stable + dynamic parts of the system prompt.
 * Used by stream handlers to pass `stableHeader` as `system:` and prepend
 * `dynamicTail` as a system-role message in `messages` for cache friendliness.
 */
export const constructSystemPromptParts = ({
    chatMode: _chatMode = "build",
    effectiveWorkMode,
    userPrompt,
    contextSize = 32000,
    optionalProjectInstructions,
    hasAnsweredQuestions: _hasAnsweredQuestions = false,
    activeModel,
    modelDisplayName,
    providerBrand,
    labelWithProvider,
    registeredToolNames,
    hasWorkspace,
}: ConstructSystemPromptParams): SystemPromptParts => {
    const base =
        optionalProjectInstructions ??
        (effectiveWorkMode
            ? getAgentsMdForWorkMode(effectiveWorkMode)
            : getAgentsMdForContextSize(contextSize));

    // PASS8 A3: <tool_contract> slimmed to the contract itself; verbose prose dropped.
    const toolContract = `<tool_contract>
Every-mode tools: read_attachment, list_attachments, compress_context, web_search, deep_research, ask_user.
Workspace tools (file read/write, search, diagram, etc.) require an open workspace folder.
If a tool is in your tool list, call it; do not claim it is missing.
Use **native function calling only**. Never emit \`<atlarix-tool-call>\`, \`<atlarix-tool_calls>\`, or other XML tool syntax in visible text.
Optional caps (max_bytes, max_lines, timeout_ms, max_output_bytes, etc.) are tuning knobs—use higher values only when the default would block legitimate work.
</tool_contract>`;

    const outputStyleRule = `<output_style>
In user-visible text, tool summaries, and markdown replies, prefer short ASCII markers or labels (e.g. [ok], [file], (check)) over emoji. The UI renders icons separately—do not rely on emoji for structure or status.
</output_style>`;

    const webResearchRules = `**Web research — pick exactly one tool per topic per turn**

- **web_search**: simple facts, version checks, error strings, single-query lookups.
- **deep_research**: complex multi-angle topics, comparisons, analysis needing several sources. It runs its own internal searches — after calling it, answer from its output; never add \`web_search\` for the same or a paraphrased topic.
- **read_url**: when the user gives a specific URL.

Never call both \`web_search\` and \`deep_research\` for overlapping topics in one turn. If \`web_search\` returns nothing or errors, tell the user they can enable **SearxNG** (Settings → Search, Docker) or a **search MCP** — Atlarix cannot enable these automatically.`;

    const includeWeb =
        effectiveWorkMode == null || modeAllowlistIncludesWebResearch(effectiveWorkMode);
    const includeViz =
        effectiveWorkMode == null || modeAllowlistIncludesVisualTools(effectiveWorkMode);
    const visualArtifactsGuide = includeViz ? loadVisualArtifactsGuide() : "";
    const inlineVizRules = includeViz
        ? `**Inline visualizations (Visual Artifacts skill)**

Before emitting any **table**, **chart**, **graph**, or **markmap**, follow the Visual Artifacts skill below. Diagrams and charts render inline as collapsible artifact cards (no side panel). When a visual clearly helps, **include it in the same reply**—do not ask "Would you like a diagram?" if you can show one. Use **one** primary visual per answer unless the user asked for multiple views.

You may also call \`get_active_skills({ filter: "visual" })\` or \`get_active_skills({ filter: "artifact" })\` for the same guidance.

${visualArtifactsGuide ? visualArtifactsGuide.trim() : ""}`
        : "";

    const identity =
        activeModel != null
            ? resolveActiveModelIdentity(activeModel)
            : null;
    const effectiveModelDisplayName =
        modelDisplayName ?? identity?.modelDisplayName;
    const modeBundle =
        effectiveWorkMode != null
            ? renderModePromptBundle(effectiveWorkMode, {
                  workspace: hasWorkspace,
                  registeredNames: registeredToolNames,
                  gitAuthorName: effectiveModelDisplayName
                      ? gitAuthorNameForModel(effectiveModelDisplayName)
                      : undefined,
              })
            : renderModeSystemBlock(undefined);
    const appVersion = getAppVersion();
    const runtimeIdentity =
        activeModel != null || modelDisplayName
            ? buildWorkstationIdentityBlock({
                  modelDisplayName:
                      modelDisplayName ??
                      identity?.modelDisplayName ??
                      "the configured model",
                  providerBrand:
                      providerBrand ?? identity?.providerBrand ?? "your provider",
                  labelWithProvider:
                      labelWithProvider ?? identity?.labelWithProvider,
                  appVersion,
              })
            : `# Atlarix runtime identity
You run inside **Atlarix** ([atlarix.dev](https://atlarix.dev)) — an agent workstation built by **NorahLabs** ([norahlabs.com](https://norahlabs.com/)).
- **App version:** \`${appVersion}\`
- If asked who built Atlarix, say **NorahLabs** ([norahlabs.com](https://norahlabs.com/)). State the app version exactly as **${appVersion}**. Do not say you have no version or that you were created by an unnamed "development team."`;

    const stableHeader = [
        base.trim(),
        toolContract,
        outputStyleRule,
        inlineVizRules,
        modeBundle,
        includeWeb ? webResearchRules : "",
        runtimeIdentity,
    ].filter((s) => s.length > 0).join("\n\n");

    // Dynamic tail: contents that vary across turns. Date only (no clock time)
    // so the tail — and everything after it in the prompt-cache prefix — stays
    // stable for a whole day instead of changing every minute.
    const currentDate = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    let tail = `# Current date
Today is ${currentDate}. Use this date when answering questions about "today", "current", or "latest", and when using web_search for time-sensitive queries.`;

    if (userPrompt && userPrompt.trim().length > 0) {
        tail += `\n\n<user_context>\n${userPrompt.trim()}\n</user_context>`;
    }
    tail += `\n\n# User input
When you need clarification or a decision from the user (architecture choices, destructive operations, ambiguous scope), call the **ask_user** tool — your turn pauses until they answer. Batch related questions into ONE call via the \`questions\` array (max 5, each with up to 4 \`options\`) instead of asking one at a time. Do not emit \`<questions>\` XML blocks or inline multiple-choice JSON in prose. After they answer, proceed without asking again for the same decision.`;

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
    activeModel?: LargeLanguageModel;
    modelDisplayName?: string;
    providerBrand?: string;
    labelWithProvider?: string;
    hasWorkspace?: boolean;
    registeredToolNames?: readonly string[];
}): Promise<string> {
    const { workspacePath, workspacePromptContent, contextSize, chatMode, effectiveWorkMode, userPrompt, hasAnsweredQuestions, activeModel, modelDisplayName, providerBrand, labelWithProvider, hasWorkspace, registeredToolNames } = params;
    const bundleContent = getAgentsMdForContextSize(contextSize);
    const layers = await loadInstructionLayers({
        workspacePath,
        workspacePromptContent,
        bundleAgentsContent: bundleContent,
    });
    const projectDocsHint = await buildProjectDocsPromptHint(workspacePath, {
        canWrite: canWriteProjectDocs(effectiveWorkMode),
    });
    const optionalProjectInstructions = [
        buildInstructionsFromLayers(layers),
        projectDocsHint,
    ].filter((s) => s.trim().length > 0).join("\n\n");
    return constructSystemPrompt({
        contextSize,
        chatMode,
        effectiveWorkMode,
        userPrompt,
        optionalProjectInstructions,
        hasAnsweredQuestions,
        activeModel,
        modelDisplayName,
        providerBrand,
        labelWithProvider,
        hasWorkspace: hasWorkspace ?? true,
        registeredToolNames,
    });
}


