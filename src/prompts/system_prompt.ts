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
 * Get AGENTS.md content based on model context size
 */
export const getAgentsMdForContextSize = (contextSize: number = 32000): string => {
    if (contextSize <= 8000 && AGENTS_MD_COMPACT) {
        return AGENTS_MD_COMPACT;
    }
    return AGENTS_MD_FULL || AGENTS_MD_COMPACT || "";
};

// ═══════════════════════════════════════════════════════════
// DEFAULT TECH STACK (fallback when no layered instructions are present)
// ═══════════════════════════════════════════════════════════

const DEFAULT_TECH_STACK = `# Tech Stack
- React + TypeScript
- Vite for bundling
- Tailwind CSS for styling
- shadcn/ui components
- React Router for navigation
- Put pages in src/pages/, components in src/components/
- Main page: src/pages/Index.tsx
`;

// ═══════════════════════════════════════════════════════════
// BUILD SYSTEM SENTINELS (e2e snapshot normalization)
// ═══════════════════════════════════════════════════════════

/** Sentinel string that starts the build/system instruction block in the prompt. Replaced in e2e with "\n${BUILD_SYSTEM_PREFIX}" for stable snapshots. */
export const BUILD_SYSTEM_PREFIX = "\n---\n";
/** Sentinel string that ends the build/system instruction block. Replaced in e2e with "${BUILD_SYSTEM_POSTFIX}" for stable snapshots. */
export const BUILD_SYSTEM_POSTFIX = "\n---\n";

// ═══════════════════════════════════════════════════════════
// CONSTRUCT SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════

export interface ConstructSystemPromptParams {
    chatMode?: "build" | "ask";
    userPrompt?: string | null;
    contextSize?: number;
    /** v2.1: When set, use as base (project instruction precedence already applied). */
    optionalProjectInstructions?: string;
    /** Legacy: unused in builder, kept for call-site compatibility. */
    enableTurboEditsV2?: boolean;
    /** v3.9: When true, omit the <questions> clarifying-questions instruction (user already answered). */
    hasAnsweredQuestions?: boolean;
}

export const constructSystemPrompt = ({
    chatMode = "build",
    userPrompt,
    contextSize = 32000,
    optionalProjectInstructions,
    hasAnsweredQuestions = false,
}: ConstructSystemPromptParams) => {
    // v2.1: Use full instruction layers when provided; else AGENTS.md + tech stack
    let prompt = optionalProjectInstructions ?? getAgentsMdForContextSize(contextSize);
    // Inject current date/time so the model uses it for web_search and time-sensitive answers
    const currentDateTime = new Date().toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    });
    prompt += `

# Current date and time
Today is ${currentDateTime}. Use this date when answering questions about "today", "current", or "latest", and when using web_search for time-sensitive queries.
`;
    if (!optionalProjectInstructions) {
        prompt += `

# Tech Stack
${DEFAULT_TECH_STACK}
`;
    }

    // Add mode-specific instruction
    if (chatMode === "ask") {
        prompt += `

---

# Mode: Ask (Read-only + optional planning)

You are in **Ask mode**: answer questions and explore the workspace with read-only tools. You may also produce a structured implementation plan when the task calls for it.

**Quick path (default):** For short factual questions, explanations, or small scope — answer directly. Use read_file, explore_folder, search_code, list_files, web_search, and analysis tools as needed. Do **not** create a plan file unless the user wants a roadmap or multi-step implementation outline.

**Plan path (multi-step / implementation-shaped work):** When the user asks for a build plan, architecture, or phased implementation — clarify if needed (\`ask_user\` or a \`<questions>\` block when ambiguity is consequential), explore the codebase with read-only tools, then write **.atlarix/ATLARIX_PLAN.md** via \`write_implementation_plan\`. In Ask mode that tool applies **without** a separate approval dialog. Tell the user to switch to **Build mode** to execute the plan.
When the user explicitly asks for a plan, create it directly with \`write_implementation_plan\` in the same turn (do not ask the user to create the file themselves).

**Deterministic discovery flow (Plan path):**
1. **High-level map first:** Use provided architecture/diagram context (if present) to pick the most relevant area.
2. **Explore target folders:** Call \`explore_folder\` (and \`list_files\` if needed) on likely paths to confirm scope.
3. **Deep-dive precisely:** Call \`get_blueprint_slice\` for those folders/files, then \`read_file\` only for required details.

Use \`get_blueprint\` only when broad architecture context is missing or stale. Do not block on full-blueprint fetch if a targeted slice can answer the task.

**CRITICAL RULES:**
- Do NOT use \`write_file\`, \`replace_code\`, \`run_command\`, or other mutating tools except \`write_implementation_plan\` for **.atlarix/ATLARIX_PLAN.md** only.
- Workforce tools in Ask mode are read-only (status/mentions/schedule/errors). Do NOT call write/trigger workforce actions.
- If you need multiple workforce services, narrate what you will access, then call \`request_workspace_permissions\` and wait for the user.

For code changes beyond **.atlarix/ATLARIX_PLAN.md**, the user should switch to **Build mode** (or approve \`request_mode_change\` when offered).
`;
    } else {
        prompt += `

---

# Mode: Build

Use function-calling tools for ALL operations. Never describe what you would do.
Workforce write/trigger actions are Build-only and must pass the standard approval flow before execution.

**Deterministic discovery flow (Build):**
1. **High-level map first:** Use available architecture/diagram context to identify the impacted subsystem.
2. **Explore target folders:** Call \`explore_folder\` / \`list_files\` to verify exact paths before edits.
3. **Deep-dive precisely:** Call \`get_blueprint_slice\` for selected paths and read only the necessary files/snippets.

Prefer targeted blueprint slices over full graph fetches. If architecture context is empty, obtain it before changing code.

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
    }

    // Add user customization if present
    if (userPrompt && userPrompt.trim().length > 0) {
        prompt += `

<user_context>
${userPrompt.trim()}
</user_context>
`;
    }

    // v3.9: Clarifying questions — only when not already answered in this chat
    if (!hasAnsweredQuestions) {
        prompt += `

---

# Clarifying questions
When you determine that a task is ambiguous in a way that would produce fundamentally different implementations depending on interpretation — such as architecture decisions, tech stack choices, destructive operations, or unclear scope — you may emit a <questions> block BEFORE your response text.

Only use this for genuinely consequential ambiguity. Do NOT ask about cosmetic details (colors, font sizes, naming conventions) unless the user explicitly asks for your opinion on these.

Format exactly as follows:
<questions>
[
  {
    "id": "q1",
    "question": "Which database should the auth system use?",
    "choices": ["PostgreSQL (existing)", "Redis (sessions only)", "Keep current setup"],
    "allowCustom": true
  },
  {
    "id": "q2",
    "question": "Should this replace the existing login flow or run alongside it?",
    "choices": ["Replace it", "Run alongside (A/B)"],
    "allowCustom": false
  }
]
</questions>

Rules:
- Emit at most ONE <questions> block per response
- Maximum 4 questions per block
- Maximum 4 choices per question
- After the user answers, proceed directly — never ask questions again in the same thread
- If you emit <questions>, do not write any other response text in that turn
`;
    }

    return prompt;
};

/**
 * v2.1: Build system prompt with project instruction precedence (ATLARIX.md, workspace, global, bundle).
 * Use when workspacePath is available for full layer loading.
 */
export async function buildSystemPromptWithProjectInstructions(params: {
    workspacePath: string;
    workspacePromptContent: string | null;
    contextSize: number;
    chatMode: "build" | "ask";
    userPrompt?: string | null;
    /** v3.9: When true, omit the <questions> instruction. */
    hasAnsweredQuestions?: boolean;
}): Promise<string> {
    const { workspacePath, workspacePromptContent, contextSize, chatMode, userPrompt, hasAnsweredQuestions } = params;
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
        userPrompt,
        optionalProjectInstructions,
        hasAnsweredQuestions,
    });
}

