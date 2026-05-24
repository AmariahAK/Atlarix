/**
 * Diagram Visualization Tools
 * ==========================
 * Generate Mermaid diagrams from code structure
 * 
 * These tools create visual diagrams that are displayed in the Right Panel
 * for the user to view. Use them when users ask about architecture, code flow,
 * or want to visualize their project structure.
 */

import { assertReadablePath } from "@/lib/security/env-secret-paths";
import { ToolRegistry, ToolCategory } from "./registry";
import fs from "fs/promises";
import path from "path";

// ============================================
// GET DIAGRAM
// ============================================

/**
 * Generate project architecture diagram
 * 
 * Examples:
 * - "Show me the architecture of this project" → architecture diagram
 * - "Generate a class diagram for auth module" → class diagram
 * - "Create a sequence diagram for login flow" → sequence diagram
 * - "Visualize the data flow" → flowchart diagram
 */
// PASS8 I: Short natural-language summary in place of the duplicated mermaid
// block previously embedded in `context_for_ai`. The mermaid source is already
// returned in `mermaid_code`; doubling it doubled the token weight per call.
function buildDiagramContextSummary(args: {
    title: string;
    diagramType: string;
    mermaidCode: string;
    focusPath?: string;
}): string {
    const lines = (args.mermaidCode || "").split("\n");
    const nodeCount = lines.filter((l) => /^\s*[A-Za-z0-9_\-.]+\s*[\[\(\{]/.test(l)).length;
    const focusSuffix = args.focusPath ? ` Focused on \`${args.focusPath}\`.` : "";
    return `Architecture diagram "${args.title}" (${args.diagramType}). ${nodeCount} top-level node${nodeCount === 1 ? "" : "s"}. Read the \`mermaid_code\` field for the full diagram source.${focusSuffix}`;
}

ToolRegistry.register({
    name: "get_diagram",
    category: ToolCategory.DIAGRAM,
    // PASS8 B1: description trimmed to ≤ 2 sentences.
    description:
        "Generate a Mermaid diagram from the workspace codebase on demand (not loaded from saved DB). " +
        "Types: architecture, class, sequence, flowchart. Pass focus_path to scope into a sub-repo.",
    cost: 10,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - only generates diagrams from existing code
    parameters: {
        workspace: {
            type: "string",
            description: "Project directory path",
            required: false,
        },
        workspaceId: {
            type: "number",
            description: "Workspace ID for saving diagram (auto-provided)",
            required: false,
        },
        diagram_type: {
            type: "string",
            description: "architecture | class | sequence | flowchart",
            required: false,
            default: "architecture",
        },
        title: {
            type: "string",
            description: "Title for the diagram",
            required: false,
        },
        type: {
            type: "string",
            enum: ["architecture", "class", "sequence", "flowchart"],
            description: "Same as diagram_type (preferred name).",
            required: false,
        },
        scope: {
            type: "string",
            enum: ["full", "folder", "file"],
            description: "full (default) | folder | file — for local generation only.",
            required: false,
        },
        path: {
            type: "string",
            description: "Workspace-relative path when scope is folder or file.",
            required: false,
        },
        // PASS8 I: focus_path mirrors get_blueprint — scopes a multi-repo
        // workspace to a single sub-project before generating / fetching.
        focus_path: {
            type: "string",
            description: "Optional sub-repo prefix (e.g. 'packages/api') to scope into for multi-repo workspaces.",
            required: false,
        },
        role: {
            type: "string",
            enum: ["main", "reference"],
            description: "main | reference — UI grouping when multiple diagrams coexist.",
            required: false,
        },
    },
    handler: async (params: {
        workspace?: string;
        workspaceId?: number;
        diagram_type?: string;
        type?: string;
        scope?: "full" | "folder" | "file";
        path?: string;
        focus_path?: string;
        title?: string;
        role?: "main" | "reference";
    }) => {
        try {
            const workspace = params.workspace || process.cwd();
            const diagramType =
                (params.type as string | undefined) ||
                params.diagram_type ||
                "architecture";
            const title = params.title || `${path.basename(workspace)} ${diagramType} diagram`;

            // Generate from codebase structure (inline chat fences are the primary visual path).
            let mermaidCode = "";
            let root = workspace;
            // PASS8 I: focus_path clamps the root before scope-based subscoping.
            if (params.focus_path) {
                root = path.join(root, params.focus_path.replace(/^\/+/, ""));
            }
            if ((params.scope === "folder" || params.scope === "file") && params.path) {
              root = path.join(root, params.path.replace(/^\/+/, ""));
            }

            switch (diagramType) {
                case "architecture":
                    mermaidCode = await generateArchitectureDiagram(root);
                    break;
                case "class":
                    mermaidCode = await generateClassDiagram(root);
                    break;
                case "sequence":
                    mermaidCode = "sequenceDiagram\n    participant User\n    participant App\n    User->>App: Interact";
                    break;
                case "flowchart":
                    mermaidCode = await generateFlowchartDiagram(root);
                    break;
                default:
                    mermaidCode = await generateArchitectureDiagram(root);
            }

            const role = params.role === "reference" ? "reference" : "main";

            // Return full context for AI to use
            return {
                success: true,
                workspace,
                workspace_id: params.workspaceId,
                diagram_type: diagramType,
                title,
                mermaid_code: mermaidCode,
                role,
                saved: params.workspaceId
                    ? "Generated on demand (not loaded from saved diagram)"
                    : "Not saved (no workspaceId provided)",
                source: "local-generation",
                // PASS8 I: short natural-language summary; mermaid lives in `mermaid_code`.
                context_for_ai: buildDiagramContextSummary({
                    title,
                    diagramType,
                    mermaidCode,
                    focusPath: params.focus_path,
                }),
            };
        } catch (error) {
            console.error('[get_diagram] Failed:', error);

            // Graceful fallback - tell AI to use other tools
            return {
                success: false,
                error: error instanceof Error ? error.message : "Diagram generation failed",
                fallbackAdvice: `Diagram generation failed, but YOU CAN STILL HELP THE USER.

Use these alternative tools to understand the codebase:

1. **get_project_structure** - Get file tree overview with framework detection (instant, never fails)
2. **search** (semantic or text mode) - Find files and code patterns
3. **list_files** - Browse directory contents
4. **read_file** - Read specific files

You have ALL the tools needed to explore and modify this codebase.
DO NOT tell the user you cannot help. Proceed with alternative exploration.`,
                context_for_ai: "Diagram failed. Use get_project_structure as your first fallback, then search for specific tasks.",
            };
        }
    },
});

// PASS6: update_diagram / generate_class_diagram / generate_sequence_diagram removed — use get_diagram with type/scope/path.

// ============================================
// HELPER FUNCTIONS
// ============================================

async function generateArchitectureDiagram(workspace: string): Promise<string> {
    // Scan project structure
    const structure = await scanProjectStructure(workspace);

    // Generate Mermaid flowchart
    let mermaid = "graph TB\n";

    // Add main folders
    structure.folders.forEach(folder => {
        const id = folder.replace(/[^a-zA-Z0-9]/g, "_");
        mermaid += `    ${id}[${folder}]\n`;
    });

    // Add some connections based on common patterns
    if (structure.folders.includes("src")) {
        const srcId = "src";
        structure.folders
            .filter(f => f.startsWith("src/"))
            .forEach(f => {
                const id = f.replace(/[^a-zA-Z0-9]/g, "_");
                mermaid += `    ${srcId} --> ${id}\n`;
            });
    }

    return mermaid;
}

async function generateClassDiagram(
    workspace: string,
    includeMethods: boolean = true
): Promise<string> {
    // Find common "class-ish" language files (best-effort; regex-first)
    const files = await findCodeFiles(workspace, [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".java",
        ".kt",
        ".kts",
        ".cs",
        ".rb",
        ".php",
        ".swift",
        ".rs",
        ".go",
        ".ex",
        ".exs",
    ]);

    let mermaid = "classDiagram\n";

    // Extract classes from files
    for (const file of files.slice(0, 10)) {
        // Limit to first 10 files
        try {
            const rel = path.relative(workspace, file);
            assertReadablePath(rel, workspace);
            const content = await fs.readFile(file, "utf-8");
            const classes = extractClasses(content);

            classes.forEach(cls => {
                mermaid += `    class ${cls.name} {\n`;

                if (includeMethods) {
                    cls.methods.forEach(method => {
                        mermaid += `        +${method}()\n`;
                    });
                }

                mermaid += `    }\n`;

                // Add inheritance
                if (cls.extends) {
                    mermaid += `    ${cls.extends} <|-- ${cls.name}\n`;
                }
            });
        } catch (error) {
            // Skip files that can't be read
        }
    }

    return mermaid || "classDiagram\n    class NoClassesFound";
}

/**
 * Generate a flowchart diagram showing data/control flow
 */
async function generateFlowchartDiagram(workspace: string): Promise<string> {
    const structure = await scanProjectStructure(workspace);

    let mermaid = "flowchart TD\n";

    // Create a flow diagram based on common patterns
    mermaid += "    Start([User Request])\n";
    mermaid += "    Start --> Router\n";

    // Add components based on folder structure
    if (structure.folders.some(f => f.includes("page") || f.includes("route"))) {
        mermaid += "    Router --> Pages[Pages/Routes]\n";
        mermaid += "    Pages --> Components[Components]\n";
    }

    if (structure.folders.some(f => f.includes("hook") || f.includes("lib"))) {
        mermaid += "    Components --> Hooks[Hooks/Logic]\n";
    }

    if (structure.folders.some(f => f.includes("api") || f.includes("service"))) {
        mermaid += "    Hooks --> API[API/Services]\n";
        mermaid += "    API --> DB[(Database)]\n";
    }

    mermaid += "    DB --> Response([Response])\n";

    // Add styling
    mermaid += "\n    style Start fill:#10B981,stroke:#059669,color:#fff\n";
    mermaid += "    style Response fill:#F59E0B,stroke:#D97706,color:#fff\n";

    return mermaid;
}

interface ProjectStructure {
    folders: string[];
    files: number;
}

async function scanProjectStructure(dir: string): Promise<ProjectStructure> {
    const folders: string[] = [];
    let fileCount = 0;

    async function scan(directory: string, prefix: string = "") {
        try {
            const entries = await fs.readdir(directory, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.name.startsWith(".") || entry.name === "node_modules") {
                    continue;
                }

                const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    folders.push(fullPath);
                    if (folders.length < 20) {
                        // Limit depth
                        await scan(path.join(directory, entry.name), fullPath);
                    }
                } else {
                    fileCount++;
                }
            }
        } catch (error) {
            // Skip inaccessible directories
        }
    }

    await scan(dir);

    return { folders, files: fileCount };
}

async function findCodeFiles(dir: string, extensions: string[]): Promise<string[]> {
    const files: string[] = [];

    async function scan(directory: string) {
        try {
            const entries = await fs.readdir(directory, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.name.startsWith(".") || entry.name === "node_modules") {
                    continue;
                }

                const fullPath = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    await scan(fullPath);
                } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                    files.push(fullPath);
                }
            }
        } catch (error) {
            // Skip
        }
    }

    await scan(dir);
    return files;
}

interface ClassInfo {
    name: string;
    methods: string[];
    extends?: string;
}

function extractClasses(content: string): ClassInfo[] {
    const classes: ClassInfo[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const classMatch =
            line.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z_][A-Za-z0-9_]*))?/) ?? // JS/TS/Java-ish
            line.match(/\binterface\s+([A-Za-z_][A-Za-z0-9_]*)/) ?? // interface
            line.match(/\brecord\s+([A-Za-z_][A-Za-z0-9_]*)/) ?? // C# record
            line.match(/\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/) ?? // Rust/Swift/C#
            line.match(/\benum\s+([A-Za-z_][A-Za-z0-9_]*)/) ?? // Rust/Swift/Java
            line.match(/^\s*(?:module|class)\s+([A-Za-z_][A-Za-z0-9_:]*)\b/) ?? // Ruby module/class
            line.match(/^\s*defmodule\s+([A-Za-z_][A-Za-z0-9_.]*)\b/) ?? // Elixir
            null;

        if (classMatch) {
            const className = classMatch[1];
            const extendsClass = classMatch[2];
            const methods: string[] = [];

            // Find methods
            for (let j = i + 1; j < Math.min(i + 50, lines.length); j++) {
                const methodMatch =
                    lines[j].match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/) ?? // JS/TS/Java/C#
                    lines[j].match(/^\s*def\s+(?:self\.)?([a-zA-Z_][a-zA-Z0-9_!?=]*)/) ?? // Ruby
                    lines[j].match(/^\s*(?:public|protected|private)?\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/) ?? // PHP
                    lines[j].match(/^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/) ?? // Swift
                    lines[j].match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/) ?? // Rust
                    lines[j].match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/) ?? // Go
                    lines[j].match(/^\s*defp?\s+([a-zA-Z_][a-zA-Z0-9_!?]*)\s*(?:\(|do\b)/) ?? // Elixir
                    null;

                if (methodMatch && !lines[j].includes("function")) {
                    methods.push(methodMatch[1]);
                }

                if (lines[j].trim() === "}" && lines[j - 1].trim() === "}") {
                    break;
                }
            }

            classes.push({
                name: className,
                methods,
                extends: extendsClass,
            });
        }
    }

    return classes;
}
