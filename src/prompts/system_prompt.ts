/**
 * Atlarix System Prompt
 * ======================
 * Minimal system prompt that loads AGENTS.md as the primary guidance.
 * v2.1: Supports project instruction precedence (ATLARIX.md, AI_RULES.md, workspace, global, bundle).
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
// DEFAULT TECH STACK (when no AI_RULES.md exists)
// ═══════════════════════════════════════════════════════════

const DEFAULT_AI_RULES = `# Tech Stack
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
    aiRules?: string | undefined;
    chatMode?: "build" | "ask";
    userPrompt?: string | null;
    contextSize?: number;
    /** v2.1: When set, use as base (project instruction precedence already applied). */
    optionalProjectInstructions?: string;
    /** Legacy: unused in builder, kept for call-site compatibility. */
    enableTurboEditsV2?: boolean;
}

export const constructSystemPrompt = ({
    aiRules,
    chatMode = "build",
    userPrompt,
    contextSize = 32000,
    optionalProjectInstructions,
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
${aiRules || DEFAULT_AI_RULES}
`;
    }

    // Add mode-specific instruction
    if (chatMode === "ask") {
        prompt += `

---

# Mode: Ask (Read-Only)

You are in **Ask mode** - explanation and guidance only.

**CRITICAL RULES:**
- Do NOT write code
- Do NOT use write_file, replace_code, run_command
- Explain concepts, answer questions
- Describe approaches without code examples
- Use read_file, search_code, web_search (read-only tools)

If user asks to create/modify code, tell them to switch to Build mode.
`;
    } else {
        prompt += `

---

# Mode: Build

Use function-calling tools for ALL operations. Never describe what you would do.

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

    // v3.5: Context-aware prompt suggestions (Option A — piggyback, zero extra API call)
    prompt += `

---

# Prompt suggestions
After your response, output a JSON block on its own line:
<suggestions>["suggestion 1", "suggestion 2", "suggestion 3"]</suggestions>
Base suggestions on what would logically come next in this task. Examples:
- After creating a component: "Add tests for this component", "Connect this to the API"
- After a build error: "Fix all TypeScript errors", "Check why this is failing"
- Fresh workspace: "Scan my codebase and give me an overview", "Generate a Blueprint"
- After a long task completes: "Review what was just built", "Update the spec"
Provide exactly 3 short, actionable suggestions. No preamble inside the tag.
`;

    return prompt;
};

/**
 * v2.1: Build system prompt with project instruction precedence (ATLARIX.md, AI_RULES.md, workspace, global, bundle).
 * Use when workspacePath is available for full layer loading.
 */
export async function buildSystemPromptWithProjectInstructions(params: {
    workspacePath: string;
    workspacePromptContent: string | null;
    contextSize: number;
    chatMode: "build" | "ask";
    userPrompt?: string | null;
}): Promise<string> {
    const { workspacePath, workspacePromptContent, contextSize, chatMode, userPrompt } = params;
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
    });
}

// ═══════════════════════════════════════════════════════════
// READ AI RULES FROM WORKSPACE
// ═══════════════════════════════════════════════════════════

export const readAiRules = async (workspacePath: string): Promise<string> => {
    const aiRulesPath = path.join(workspacePath, "AI_RULES.md");
    try {
        const content = await fs.promises.readFile(aiRulesPath, "utf8");
        return content;
    } catch {
        logger.debug("No AI_RULES.md found, using defaults");
        return DEFAULT_AI_RULES;
    }
};
