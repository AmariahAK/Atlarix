/**
 * Diagram Visualization Tools
 * ==========================
 * Generate Mermaid diagrams from code structure
 */

import { ToolRegistry, ToolCategory } from "./registry";
import fs from "fs/promises";
import path from "path";

// ============================================
// GET DIAGRAM
// ============================================

/**
 * Get current project architecture diagram
 */
ToolRegistry.register({
    name: "get_diagram",
    category: ToolCategory.DIAGRAM,
    description: "Generate Mermaid diagram of project architecture",
    cost: 10,
    requiresWorkspace: true,
    isCore: true,
    parameters: {
        workspace: {
            type: "string",
            description: "Project directory",
            required: false,
        },
        diagram_type: {
            type: "string",
            description: "Type: 'architecture', 'class', 'sequence'",
            required: false,
            default: "architecture",
        },
    },
    handler: async (params: {
        workspace?: string;
        diagram_type?: string;
    }) => {
        try {
            const workspace = params.workspace || process.cwd();
            const diagramType = params.diagram_type || "architecture";

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
                default:
                    mermaidCode = await generateArchitectureDiagram(workspace);
            }

            return {
                success: true,
                workspace,
                diagram_type: diagramType,
                mermaid_code: mermaidCode,
                preview_url: `https://mermaid.ink/img/${Buffer.from(mermaidCode).toString("base64")}`,
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
// UPDATE DIAGRAM
// ============================================

/**
 * Update diagram based on code changes
 */
ToolRegistry.register({
    name: "update_diagram",
    category: ToolCategory.DIAGRAM,
    description: "Update existing diagram with new changes",
    parameters: {
        workspace: {
            type: "string",
            description: "Project directory",
            required: false,
        },
        changes: {
            type: "array",
            description: "List of changed files",
            required: false,
        },
    },
    cost: 8,
    handler: async (params: {
        workspace?: string;
        changes?: string[];
    }) => {
        try {
            const workspace = params.workspace || process.cwd();

            // Regenerate diagram
            const mermaidCode = await generateArchitectureDiagram(workspace);

            return {
                success: true,
                workspace,
                changes_count: params.changes?.length || 0,
                mermaid_code: mermaidCode,
                updated_at: new Date().toISOString(),
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
    // Find TypeScript/JavaScript files
    const files = await findCodeFiles(workspace, [".ts", ".tsx", ".js", ".jsx"]);

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
        const classMatch = line.match(/class\s+(\w+)(?:\s+extends\s+(\w+))?/);

        if (classMatch) {
            const className = classMatch[1];
            const extendsClass = classMatch[2];
            const methods: string[] = [];

            // Find methods
            for (let j = i + 1; j < Math.min(i + 50, lines.length); j++) {
                const methodMatch = lines[j].match(/(\w+)\s*\([^)]*\)\s*{/);
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
