/**
 * Template & Scaffolding Tools
 * ============================
 * Generate projects from templates using GitHub API
 */

import { ToolRegistry, ToolCategory } from "./registry";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// ============================================
// GENERATE FROM TEMPLATE
// ============================================

/**
 * Scaffold a new project from a template
 * Uses GitHub templates, npx CLIs, or curated registry
 */
ToolRegistry.register({
    name: "generate_from_template",
    category: ToolCategory.CODE,
    description: "Create a new project from a template (GitHub, npx CLI, or registry)",
    parameters: {
        template_id: {
            type: "string",
            description: "Template identifier (e.g., 'nextjs-typescript', 'github:user/repo')",
            required: true,
        },
        destination: {
            type: "string",
            description: "Where to create the project",
            required: true,
        },
        customizations: {
            type: "object",
            description: "Optional variables to replace in template",
            required: false,
        },
    },
    cost: 15,
    requiresWorkspace: true,
    isCore: true, // Core scaffolding tool
    handler: async (params: {
        template_id: string;
        destination: string;
        customizations?: Record<string, string>;
    }) => {
        try {
            // Determine template type
            const templateType = detectTemplateType(params.template_id);

            let command: string;
            let description: string;

            switch (templateType) {
                case "npm-cli":
                    // e.g., nextjs, vite, react
                    const cliCommands: Record<string, string> = {
                        "nextjs": `npx create-next-app@latest ${params.destination} --typescript --tailwind --app --no-src-dir`,
                        "nextjs-typescript": `npx create-next-app@latest ${params.destination} --typescript --tailwind --app`,
                        "vite-react": `npm create vite@latest ${params.destination} -- --template react-ts`,
                        "vite-vue": `npm create vite@latest ${params.destination} -- --template vue-ts`,
                        "react": `npx create-react-app ${params.destination} --template typescript`,
                        "express": `npx express-generator ${params.destination}`,
                        "fastapi": `fastapi create ${params.destination}`,
                        "t3-stack": `npm create t3-app@latest ${params.destination}`,
                    };

                    command = cliCommands[params.template_id] || cliCommands["nextjs"];
                    description = `Scaffolding ${params.template_id} project`;
                    break;

                case "github":
                    // e.g., github:vercel/next.js/tree/canary/examples/blog
                    const repoUrl = params.template_id.replace("github:", "https://github.com/");
                    command = `git clone ${repoUrl} ${params.destination}`;
                    description = `Cloning GitHub template`;
                    break;

                case "url":
                    // Direct GitHub URL
                    command = `git clone ${params.template_id} ${params.destination}`;
                    description = `Cloning template from URL`;
                    break;

                default:
                    // Try as npm CLI
                    command = `npx create-${params.template_id}@latest ${params.destination}`;
                    description = `Creating ${params.template_id} project`;
            }

            // Execute the command
            const { stdout, stderr } = await execAsync(command, {
                maxBuffer: 10 * 1024 * 1024,
            });

            // Apply customizations if provided
            if (params.customizations) {
                await applyTemplateCustomizations(params.destination, params.customizations);
            }

            // Auto-install dependencies
            let installOutput = "";
            try {
                const packageJsonPath = path.join(params.destination, "package.json");
                const packageJsonExists = await fs
                    .access(packageJsonPath)
                    .then(() => true)
                    .catch(() => false);

                if (packageJsonExists) {
                    const { stdout: installStdout } = await execAsync("npm install", {
                        cwd: params.destination,
                        maxBuffer: 10 * 1024 * 1024,
                    });
                    installOutput = installStdout;
                }
            } catch (error) {
                // Installation failed, but continue
                installOutput = `Installation failed: ${error}`;
            }

            return {
                success: true,
                template_id: params.template_id,
                destination: params.destination,
                description,
                output: stdout || stderr,
                install_output: installOutput,
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
// IMPORT EXTERNAL CODE
// ============================================

/**
 * Import code snippets from external sources
 * Useful for copying  examples from documentation
 */
ToolRegistry.register({
    name: "import_external_code",
    category: ToolCategory.CODE,
    description: "Import code snippet from external source (GitHub file, gist, etc.)",
    parameters: {
        source_url: {
            type: "string",
            description: "URL to source code (GitHub file, raw URL, gist)",
            required: true,
        },
        destination: {
            type: "string",
            description: "Local file path to save to",
            required: true,
        },
        extract_section: {
            type: "string",
            description: "Optional: Extract specific function/class name",
            required: false,
        },
    },
    cost: 5,
    handler: async (params: {
        source_url: string;
        destination: string;
        extract_section?: string;
    }) => {
        try {
            // Convert GitHub URLs to raw URLs
            let rawUrl = params.source_url;
            if (rawUrl.includes("github.com") && !rawUrl.includes("raw.githubusercontent.com")) {
                rawUrl = rawUrl
                    .replace("github.com", "raw.githubusercontent.com")
                    .replace("/blob/", "/");
            }

            // Fetch the code
            const response = await fetch(rawUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.statusText}`);
            }

            let content = await response.text();

            // Extract specific section if requested
            if (params.extract_section) {
                content = extractCodeSection(content, params.extract_section);
            }

            // Ensure destination directory exists
            const destDir = path.dirname(params.destination);
            await fs.mkdir(destDir, { recursive: true });

            // Write the file
            await fs.writeFile(params.destination, content, "utf-8");

            return {
                success: true,
                source_url: params.source_url,
                destination: params.destination,
                size_bytes: content.length,
                extracted_section: params.extract_section || null,
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

function detectTemplateType(templateId: string): "npm-cli" | "github" | "url" | "unknown" {
    if (templateId.startsWith("github:")) {
        return "github";
    }

    if (templateId.startsWith("http://") || templateId.startsWith("https://")) {
        return "url";
    }

    // Known npm CLIs
    const npmTemplates = [
        "nextjs",
        "nextjs-typescript",
        "vite-react",
        "vite-vue",
        "react",
        "express",
        "fastapi",
        "t3-stack",
    ];

    if (npmTemplates.includes(templateId)) {
        return "npm-cli";
    }

    return "unknown";
}

async function applyTemplateCustomizations(
    projectPath: string,
    customizations: Record<string, string>
): Promise<void> {
    // Replace variables in package.json
    const packageJsonPath = path.join(projectPath, "package.json");
    try {
        const packageJson = await fs.readFile(packageJsonPath, "utf-8");
        let modified = packageJson;

        for (const [key, value] of Object.entries(customizations)) {
            const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
            modified = modified.replace(regex, value);
        }

        await fs.writeFile(packageJsonPath, modified, "utf-8");
    } catch (error) {
        // package.json might not exist
    }

    // Replace in README.md
    const readmePath = path.join(projectPath, "README.md");
    try {
        const readme = await fs.readFile(readmePath, "utf-8");
        let modified = readme;

        for (const [key, value] of Object.entries(customizations)) {
            const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
            modified = modified.replace(regex, value);
        }

        await fs.writeFile(readmePath, modified, "utf-8");
    } catch (error) {
        // README might not exist
    }
}

function extractCodeSection(content: string, sectionName: string): string {
    // Simple function/class extraction
    const lines = content.split("\n");
    const patterns = [
        new RegExp(`function\\s+${sectionName}\\s*\\(`),
        new RegExp(`const\\s+${sectionName}\\s*=`),
        new RegExp(`class\\s+${sectionName}\\s*{`),
        new RegExp(`export\\s+function\\s+${sectionName}\\s*\\(`),
        new RegExp(`export\\s+class\\s+${sectionName}\\s*{`),
    ];

    let startLine = -1;
    let endLine = -1;

    for (let i = 0; i < lines.length; i++) {
        if (patterns.some(p => p.test(lines[i]))) {
            startLine = i;

            // Find the end (brace counting)
            let braceCount = 0;
            let inSection = false;

            for (let j = i; j < lines.length; j++) {
                const line = lines[j];

                for (const char of line) {
                    if (char === "{") {
                        braceCount++;
                        inSection = true;
                    } else if (char === "}") {
                        braceCount--;
                    }
                }

                if (inSection && braceCount === 0) {
                    endLine = j;
                    break;
                }
            }
            break;
        }
    }

    if (startLine !== -1 && endLine !== -1) {
        return lines.slice(startLine, endLine + 1).join("\n");
    }

    // If extraction fails, return entire content
    return content;
}
