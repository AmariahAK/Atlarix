/**
 * AI-Driven Template Search and Application
 * =========================================
 * Tools for searching and applying templates
 */

import { ToolRegistry, ToolCategory } from "./registry";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { localTemplatesData, type Template } from "../../shared/templates";

const execAsync = promisify(exec);

// ============================================
// SEARCH TEMPLATES
// ============================================

/**
 * Search for templates matching user's description
 * Returns top 3 matches from curated registry
 */
ToolRegistry.register({
    name: "search_templates",
    category: ToolCategory.CODE,
    description: `Search for project templates matching user's description.
    
Returns top 3 curated templates with:
- Template ID, name, description
- Tech stack, difficulty level
- GitHub stars (if available)
- Live demo URL

Use when user describes a project without selecting a specific template.

Examples:
- "blog with MDX" → Returns Next.js blog templates
- "React dashboard" → Returns React/Vite admin templates  
- "fullstack e-commerce" → Returns fullstack shop templates`,
    cost: 2,
    requiresWorkspace: false, // Can search before workspace created
    isCore: true,
    parameters: {
        query: {
            type: "string",
            description: "User's project description or keywords (e.g., 'blog MDX dark mode')",
            required: true,
        },
        category: {
            type: "string",
            description: "Optional filter: frontend, backend, fullstack, mobile, api, cli",
            required: false,
        },
        max_results: {
            type: "number",
            description: "Maximum templates to return (default: 3)",
            required: false,
        },
    },
    handler: async (params: {
        query: string;
        category?: string;
        max_results?: number;
    }) => {
        try {
            const maxResults = params.max_results || 3;

            // Search local template registry
            let templates = localTemplatesData;

            // Filter by category if specified
            if (params.category) {
                templates = templates.filter(
                    (t) => t.category === params.category
                );
            }

            // Simple keyword matching (can be enhanced with fuzzy search)
            const query = params.query.toLowerCase();
            const keywords = query.split(" ");

            const scored = templates.map((template) => {
                const searchText = `${template.title} ${template.description} ${template.techStack?.join(" ")}`.toLowerCase();

                // Score based on keyword matches
                let score = 0;
                keywords.forEach((keyword) => {
                    if (searchText.includes(keyword)) {
                        score += 1;
                    }
                });

                // Boost official templates
                if (template.isOfficial) score += 0.5;

                // Boost by stars (if available)
                if (template.stars) {
                    score += Math.min(template.stars / 1000, 2); // Max +2 bonus
                }

                return { template, score };
            });

            // Sort by score and take top results
            const topMatches = scored
                .filter((item) => item.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResults)
                .map((item) => item.template);

            if (topMatches.length === 0) {
                return {
                    success: true,
                    templates: [],
                    message: `No templates found for "${params.query}". Try broader keywords or build from scratch.`,
                };
            }

            return {
                success: true,
                templates: topMatches.map((t) => ({
                    id: t.id,
                    name: t.title,
                    description: t.description,
                    tech_stack: t.techStack || [],
                    difficulty: t.difficulty || "intermediate",
                    category: t.category || "fullstack",
                    github_url: t.githubUrl,
                    demo_url: t.demoUrl,
                    stars: t.stars,
                    is_official: t.isOfficial,
                })),
                total_found: topMatches.length,
                message: `Found ${topMatches.length} matching template(s). Present these options to the user.`,
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
// APPLY TEMPLATE
// ============================================

/**
 * Apply a template to the current workspace
 * Clones template code, removes .git, initializes new repo
 */
ToolRegistry.register({
    name: "apply_template",
    category: ToolCategory.CODE,
    description: `Apply a template to the current workspace.
    
MUST be used AFTER workspace is created.

What it does:
1. Git clone template to workspace
2. Remove template's .git folder
3. Initialize new git repo
4. List created files

After applying, you can:
- Use read_file to understand structure
- Use write_file to modify files
- Customize to match user's exact needs

IMPORTANT: Call this ONCE per workspace. Don't call multiple times.`,
    cost: 10,
    requiresWorkspace: true,
    isCore: true,
    parameters: {
        template_id: {
            type: "string",
            description: "Template ID from search_templates or manual selection",
            required: true,
        },
        customizations: {
            type: "object",
            description: "Optional: Initial variable replacements (e.g., {PROJECT_NAME: 'MyApp'})",
            required: false,
        },
    },
    handler: async (params: {
        template_id: string;
        customizations?: Record<string, string>;
        workspacePath?: string; // Injected by system
    }) => {
        try {
            // Get template from registry
            const template = localTemplatesData.find((t) => t.id === params.template_id);

            if (!template) {
                return {
                    success: false,
                    error: `Template "${params.template_id}" not found in registry`,
                };
            }

            if (!template.githubUrl) {
                return {
                    success: false,
                    error: `Template "${params.template_id}" does not have a GitHub URL`,
                };
            }

            // Get workspace path (should be injected by system)
            const workspacePath = params.workspacePath || process.cwd();

            // Clone template
            const cloneCommand = `git clone --depth 1 ${template.githubUrl} ${workspacePath}`;
            await execAsync(cloneCommand, {
                maxBuffer: 10 * 1024 * 1024,
            });

            // Remove .git folder
            await execAsync(`rm -rf ${path.join(workspacePath, ".git")}`, {
                cwd: workspacePath,
            });

            // Initialize new git repo
            await execAsync("git init", { cwd: workspacePath });
            await execAsync('git add .', { cwd: workspacePath });
            await execAsync('git commit -m "Initial commit from template"', {
                cwd: workspacePath,
            });

            // Apply customizations if provided
            if (params.customizations) {
                await applyTemplateCustomizations(workspacePath, params.customizations);
            }

            // List created files
            const { stdout: lsOutput } = await execAsync(
                "find . -type f -not -path '*/\\.git/*' -not -path '*/node_modules/*' | head -  n 30",
                { cwd: workspacePath }
            );

            const fileList = lsOutput
                .trim()
                .split("\n")
                .filter(Boolean)
                .slice(0, 20); // Limit to 20 files

            return {
                success: true,
                template_id: params.template_id,
                template_name: template.title,
                workspace_path: workspacePath,
                files_created: fileList,
                message: `Template "${template.title}" applied to workspace.
                
Files created (showing first ${fileList.length}):
${fileList.join("\n")}

Use read_file to understand structure, then modify files to match user's needs.`,
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
