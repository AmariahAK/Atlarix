/**
 * Diagram Visualization Tools
 * ==========================
 * Generate Mermaid diagrams from code structure
 * 
 * These tools create visual diagrams that are displayed in the Right Panel
 * for the user to view. Use them when users ask about architecture, code flow,
 * or want to visualize their project structure.
 */

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
ToolRegistry.register({
    name: "get_diagram",
    category: ToolCategory.DIAGRAM,
    description: "Generate Mermaid diagram. Types: architecture, class, sequence, flowchart.",
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
            description: "Type of diagram: 'architecture', 'class', 'sequence', 'flowchart'",
            required: false,
            default: "architecture",
        },
        title: {
            type: "string",
            description: "Title for the diagram",
            required: false,
        },
    },
    handler: async (params: {
        workspace?: string;
        workspaceId?: number;
        diagram_type?: string;
        title?: string;
    }) => {
        try {
            const workspace = params.workspace || process.cwd();
            const diagramType = params.diagram_type || "architecture";
            const title = params.title || `${path.basename(workspace)} ${diagramType} diagram`;

            // If workspaceId provided, try to get AI-generated diagram first
            if (params.workspaceId) {
                try {
                    const { DiagramManager } = await import("../DiagramManager");
                    const { db } = await import("../../db");
                    const { diagrams } = await import("../../db/schema");
                    const { eq } = await import("drizzle-orm");

                    // Check for existing diagram
                    let existingDiagram = await db.query.diagrams.findFirst({
                        where: eq(diagrams.workspaceId, params.workspaceId),
                    });

                    // If no diagram exists, check if one is being generated (cold start)
                    if (!existingDiagram) {
                        if (DiagramManager.isGenerating(params.workspaceId)) {
                            // Wait for in-progress generation (up to 30s)
                            console.log(`[get_diagram] Waiting for in-progress generation for workspace ${params.workspaceId}`);
                            const generatedDiagram = await DiagramManager.waitForGeneration(params.workspaceId, 30000);

                            if (generatedDiagram) {
                                return {
                                    success: true,
                                    workspace,
                                    diagram_type: diagramType,
                                    title: generatedDiagram.title,
                                    mermaid_code: generatedDiagram.content,
                                    saved: "Retrieved from AI-generated diagram (waited for generation)",
                                    source: "waited-for-generation",
                                    context_for_ai: `
## Architecture Diagram: ${generatedDiagram.title}

This diagram shows the project structure (AI-generated):

\`\`\`mermaid
${generatedDiagram.content}
\`\`\`

Use this to understand the codebase layout before making changes.
`,
                                    _showInPanel: true,
                                    _panelType: "diagram",
                                };
                            }
                        }

                        // No generation in progress, start one now
                        console.log(`[get_diagram] No diagram found, generating on-demand for workspace ${params.workspaceId}`);
                        const newDiagram = await DiagramManager.generateInitialDiagram(params.workspaceId, workspace);

                        return {
                            success: true,
                            workspace,
                            diagram_type: diagramType,
                            title: newDiagram.title,
                            mermaid_code: newDiagram.content,
                            saved: "Generated and saved to workspace",
                            source: "on-demand-generation",
                            context_for_ai: `
## Architecture Diagram: ${newDiagram.title}

This diagram shows the project structure (AI-generated):

\`\`\`mermaid
${newDiagram.content}
\`\`\`

Use this to understand the codebase layout before making changes.
`,
                            _showInPanel: true,
                            _panelType: "diagram",
                        };
                    }

                    // Existing diagram found - return it
                    return {
                        success: true,
                        workspace,
                        diagram_type: existingDiagram.diagramType,
                        title: existingDiagram.title,
                        mermaid_code: existingDiagram.content,
                        saved: "Retrieved from saved diagram",
                        source: "database",
                        context_for_ai: `
## Architecture Diagram: ${existingDiagram.title}

This diagram shows the project structure:

\`\`\`mermaid
${existingDiagram.content}
\`\`\`

Use this to understand the codebase layout before making changes.
`,
                        _showInPanel: true,
                        _panelType: "diagram",
                    };
                } catch (dbError) {
                    console.error("[get_diagram] Failed to fetch from database, falling back to local generation:", dbError);
                    // Fall through to local generation below
                }
            }

            // Fallback: Generate locally without saving (for when no workspaceId)
            let mermaidCode = "";

            switch (diagramType) {
                case "architecture":
                    mermaidCode = await generateArchitectureDiagram(workspace);
                    break;
                case "class":
                    mermaidCode = await generateClassDiagram(workspace);
                    break;
                case "sequence":
                    mermaidCode = "sequenceDiagram\n    participant User\n    participant App\n    User->>App: Interact";
                    break;
                case "flowchart":
                    mermaidCode = await generateFlowchartDiagram(workspace);
                    break;
                default:
                    mermaidCode = await generateArchitectureDiagram(workspace);
            }

            // Return full context for AI to use
            return {
                success: true,
                workspace,
                diagram_type: diagramType,
                title,
                mermaid_code: mermaidCode,
                saved: "Not saved (no workspaceId provided)",
                source: "local-generation",
                context_for_ai: `
## Architecture Diagram: ${title}

This diagram shows the project structure:

\`\`\`mermaid
${mermaidCode}
\`\`\`

Use this to understand the codebase layout before making changes.
`,
                // Signal to show in Right Panel
                _showInPanel: true,
                _panelType: "diagram",
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
2. **find_relevant_files** - Search for files by keyword/feature name
3. **search_code** - Find specific code patterns
4. **list_files** - Browse directory contents
5. **read_file** - Read specific files

You have ALL the tools needed to explore and modify this codebase.
DO NOT tell the user you cannot help. Proceed with alternative exploration.`,
                context_for_ai: "Diagram failed. Use get_project_structure as your first fallback, then find_relevant_files for specific tasks.",
            };
        }
    },
});

// ============================================
// UPDATE DIAGRAM (AI-Controlled)
// ============================================

/**
 * Request diagram update after architectural changes
 * Returns a permission request that the user must approve
 * 
 * The AI decides when to call this based on the changes it made:
 * - New major components (AuthService, StateManager)
 * - Folder restructures
 * - New integrations (Redux, Supabase, API clients)
 */
ToolRegistry.register({
    name: "update_diagram",
    category: ToolCategory.DIAGRAM,
    description: `Request diagram update after architectural changes.

USE WHEN YOU'VE MADE:
✅ New major components (StateManager, APIClient, AuthService)
✅ Folder restructures (moved components, added modules)
✅ New integrations (Redux, Supabase, API clients)
✅ Major refactors that change module relationships

DON'T USE FOR:
❌ Import fixes, typos, CSS changes
❌ Minor bug fixes, documentation updates
❌ Adding console.logs or comments
❌ Small function changes within existing components

The user will see a preview and can approve or skip the diagram regeneration.`,
    parameters: {
        updateType: {
            type: "string",
            description: "Severity: 'minor' (small structural change), 'major' (significant refactor), 'new_component' (added new module)",
            required: true,
            enum: ["minor", "major", "new_component"],
        },
        affectedComponents: {
            type: "array",
            description: "List of components/modules affected by the change",
            required: true,
        },
        changeDescription: {
            type: "string",
            description: "Brief description of what changed architecturally",
            required: true,
        },
        suggestedFocus: {
            type: "string",
            description: "Optional: Which part of the diagram to focus on during regeneration",
            required: false,
        },
    },
    cost: 8,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false, // This modifies diagram state
    handler: async (params: {
        updateType: "minor" | "major" | "new_component";
        affectedComponents: string[];
        changeDescription: string;
        suggestedFocus?: string;
    }) => {
        // Return permission request - doesn't execute immediately
        // The interceptor will handle this when user approves
        return {
            __permission_required: true,
            operation: "update_diagram",
            preview: {
                type: params.updateType,
                components: params.affectedComponents,
                description: params.changeDescription,
                focus: params.suggestedFocus,
            },
        };
    },
});

// ============================================
// GENERATE CLASS DIAGRAM
// ============================================

/**
 * Generate UML class diagram from code
 */
ToolRegistry.register({
    name: "generate_class_diagram",
    category: ToolCategory.DIAGRAM,
    description: "Generate UML class diagram from codebase",
    parameters: {
        workspace: {
            type: "string",
            description: "Project directory",
            required: false,
        },
        include_methods: {
            type: "boolean",
            description: "Include methods in diagram",
            required: false,
            default: true,
        },
    },
    cost: 12,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode
    handler: async (params: {
        workspace?: string;
        include_methods?: boolean;
    }) => {
        try {
            const workspace = params.workspace || process.cwd();
            const includeMethods = params.include_methods !== false;

            const mermaidCode = await generateClassDiagram(workspace, includeMethods);

            return {
                success: true,
                workspace,
                mermaid_code: mermaidCode,
                include_methods: includeMethods,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ============================================
// GENERATE SEQUENCE DIAGRAM
// ============================================

/**
 * Generate sequence diagram from code flow
 */
ToolRegistry.register({
    name: "generate_sequence_diagram",
    category: ToolCategory.DIAGRAM,
    description: "Generate sequence diagram showing code flow",
    parameters: {
        entry_point: {
            type: "string",
            description: "Entry point file/function",
            required: true,
        },
        max_depth: {
            type: "number",
            description: "Maximum call depth to trace",
            required: false,
            default: 5,
        },
    },
    cost: 15,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode
    handler: async (params: {
        entry_point: string;
        max_depth?: number;
    }) => {
        try {
            // Simple sequence diagram generation
            const mermaidCode = `sequenceDiagram
    participant User
    participant ${path.basename(params.entry_point, path.extname(params.entry_point))}
    participant Backend
    participant Database
    
    User->>${path.basename(params.entry_point, path.extname(params.entry_point))}: Call function
    ${path.basename(params.entry_point, path.extname(params.entry_point))}->>Backend: Process request
    Backend->>Database: Query data
    Database-->>Backend: Return results
    Backend-->>${path.basename(params.entry_point, path.extname(params.entry_point))}: Response
    ${path.basename(params.entry_point, path.extname(params.entry_point))}-->>User: Display result`;

            return {
                success: true,
                entry_point: params.entry_point,
                mermaid_code: mermaidCode,
                max_depth: params.max_depth || 5,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

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
