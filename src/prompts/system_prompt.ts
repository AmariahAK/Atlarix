/**
 * Atlarix System Prompt
 * ======================
 * Minimal system prompt that loads AGENTS.md as the primary guidance.
 * 
 * - AGENTS.md: Full reference (55 tools) for 32K+ models
 * - AGENTS_COMPACT.md: Essential guidance (~100 lines) for 8K models
 */

import path from "node:path";
import fs from "node:fs";
import log from "electron-log";

const logger = log.scope("system_prompt");

// ═══════════════════════════════════════════════════════════
// AGENTS.MD LOADING
// ═══════════════════════════════════════════════════════════

let AGENTS_MD_FULL = "";
let AGENTS_MD_COMPACT = "";

const loadAgentsFile = (filename: string): string => {
    const paths = [
        path.join(process.cwd(), filename),
        path.join(__dirname, "../../", filename),
        path.join(__dirname, "../../../", filename),
    ];

    for (const p of paths) {
        try {
            if (fs.existsSync(p)) {
                const content = fs.readFileSync(p, "utf-8");
                logger.info(`Loaded ${filename} from ${p} (${content.length} bytes)`);
                return content;
            }
        } catch { /* try next */ }
    }

    logger.warn(`${filename} not found`);
    return "";
};

// Load at startup
AGENTS_MD_FULL = loadAgentsFile("AGENTS.md");
AGENTS_MD_COMPACT = loadAgentsFile("AGENTS_COMPACT.md");

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
// CONSTRUCT SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════

export const constructSystemPrompt = ({
    aiRules,
    chatMode = "build",
    userPrompt,
    contextSize = 32000,
}: {
    aiRules: string | undefined;
    chatMode?: "build" | "ask";
    userPrompt?: string | null;
    contextSize?: number;
}) => {
    // Start with AGENTS.md (sized for model)
    let prompt = getAgentsMdForContextSize(contextSize);

    // Add mode-specific instruction
    if (chatMode === "ask") {
        prompt += `

---

# Mode: Ask (Read-Only)

You are in **Ask mode** - explanation and guidance only.

**CRITICAL RULES:**
- ❌ Do NOT write code
- ❌ Do NOT use write_file, replace_code, run_command
- ✅ Explain concepts, answer questions
- ✅ Describe approaches without code examples
- ✅ Use read_file, search_code, web_search (read-only tools)

If user asks to create/modify code, tell them to switch to Build mode.
`;
    } else {
        prompt += `

---

# Mode: Build

Use function-calling tools for ALL operations. Never describe what you would do.

## Task Completion Signal
When you have FULLY completed a task and ALL features work:
1. Test that everything actually works
2. Output EXACTLY: <task_complete>Task finished successfully</task_complete>

✅ Use <task_complete> when:
- Created all requested files and they compile/run without errors
- All tests pass
- All features work as described

❌ Do NOT use <task_complete> if:
- Waiting for user approval of file changes
- Encountered an error that blocks progress
- Need more information from the user
- Tests are failing or code has syntax errors

If unsure, do NOT output <task_complete>. It's better to continue than stop prematurely.
`;
    }

    // Add tech stack rules
    prompt += `

# Tech Stack
${aiRules || DEFAULT_AI_RULES}
`;

    // Add user customization if present
    if (userPrompt && userPrompt.trim().length > 0) {
        prompt += `

<user_context>
${userPrompt.trim()}
</user_context>
`;
    }

    return prompt;
};

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
