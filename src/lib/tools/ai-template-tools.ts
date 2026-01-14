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
import { localTemplatesData, CLI_TEMPLATES, type Template } from "../../shared/templates";

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
    description: "Search for project templates. Returns top 3 matches with tech stack and demo URLs.",
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
            let topMatches = scored
                .filter((item) => item.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResults)
                .map((item) => item.template);

            // ═══════════════════════════════════════════════════════════
            // SEARXNG INTEGRATION: Fetch fresh templates when local results sparse
            // ═══════════════════════════════════════════════════════════
            if (topMatches.length < maxResults) {
                try {
                    const { smartSearch, isSearxngEnabled } = await import("../search");

                    // Only use SearxNG if enabled
                    if (isSearxngEnabled()) {
                        console.log('[search_templates] Local results sparse, searching SearxNG for fresh templates...');

                        // Search for GitHub templates
                        const searchQuery = `${params.query} github template starter kit site:github.com`;
                        const searxngResults = await smartSearch(searchQuery, 5);

                        // Parse GitHub URLs and create template entries
                        const freshTemplates = searxngResults
                            .filter(r => r.url.includes('github.com'))
                            .map(r => {
                                // Extract repo name from URL
                                const urlParts = r.url.split('/');
                                const repoName = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
                                const owner = urlParts[urlParts.length - 2] || urlParts[urlParts.length - 3];

                                return {
                                    id: `${owner}/${repoName}`,
                                    title: r.title.replace(' - GitHub', '').replace(' · GitHub', ''),
                                    description: r.snippet.slice(0, 200),
                                    imageUrl: '', // SearxNG doesn't provide preview images
                                    techStack: [] as string[],
                                    category: params.category || 'fullstack',
                                    githubUrl: r.url,
                                    stars: 0,
                                    isOfficial: false,
                                    source: 'searxng', // Mark as SearxNG-discovered
                                } as Template & { source: string };
                            });

                        // Merge with local results (avoid duplicates)
                        const existingIds = new Set(topMatches.map(t => t.id));
                        for (const fresh of freshTemplates) {
                            if (!existingIds.has(fresh.id) && topMatches.length < maxResults) {
                                topMatches.push(fresh as Template);
                            }
                        }

                        console.log(`[search_templates] Added ${freshTemplates.length} templates from SearxNG`);
                    }
                } catch (searxError) {
                    console.warn('[search_templates] SearxNG search failed, using local results only:', searxError);
                }
            }

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
                    source: (t as any).source || 'local', // Indicate source
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
 * Priority: 1) CLI command, 2) ZIP download, 3) Git clone (deprecated)
 */
ToolRegistry.register({
    name: "apply_template",
    category: ToolCategory.CODE,
    description: "Scaffold a project from template. Uses CLI commands (fast) or ZIP download. Call AFTER create_workspace.",
    cost: 10,
    requiresWorkspace: true,
    isCore: true,
    parameters: {
        template_id: {
            type: "string",
            description: "Template ID from search_templates or CLI_TEMPLATES catalog",
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
            const workspacePath = params.workspacePath || process.cwd();

            // Find template in local registry
            const template = localTemplatesData.find((t) => t.id === params.template_id);

            // Check if it's a direct CLI_TEMPLATES entry
            const cliTemplate = CLI_TEMPLATES[params.template_id];

            let method = 'unknown';
            let templateName = template?.title || params.template_id;

            // ═══════════════════════════════════════════════════════════════
            // PRIORITY 1: CLI Command (fastest, most reliable)
            // ═══════════════════════════════════════════════════════════════
            const cliCommand = template?.cliCommand || cliTemplate?.command;
            const postInstall = template?.postInstall || cliTemplate?.postInstall;

            if (cliCommand) {
                console.log(`[apply_template] Using CLI command for ${params.template_id}`);
                const command = cliCommand.replace('{path}', workspacePath).replace('{name}', path.basename(workspacePath));

                await execAsync(command, {
                    maxBuffer: 50 * 1024 * 1024,
                    timeout: 120000, // 2 min timeout
                });

                // Run post-install if needed
                if (postInstall) {
                    await execAsync(postInstall, {
                        cwd: workspacePath,
                        maxBuffer: 50 * 1024 * 1024,
                        timeout: 300000, // 5 min for npm install
                    });
                }

                // Initialize git if not already done
                await initGitIfNeeded(workspacePath);

                method = 'cli';
            }
            // ═══════════════════════════════════════════════════════════════
            // PRIORITY 2: ZIP Download (faster than git clone, no rate limits)
            // ═══════════════════════════════════════════════════════════════
            else if (template?.githubUrl) {
                console.log(`[apply_template] Using ZIP download for ${params.template_id}`);

                await downloadGitHubZip(template.githubUrl, workspacePath);

                // Install dependencies
                try {
                    await execAsync('npm install', {
                        cwd: workspacePath,
                        maxBuffer: 50 * 1024 * 1024,
                        timeout: 300000,
                    });
                } catch {
                    // npm install might fail, that's ok
                }

                // Initialize git
                await initGitIfNeeded(workspacePath);

                method = 'zip';
            }
            // ═══════════════════════════════════════════════════════════════
            // FALLBACK: Error - no valid template source
            // ═══════════════════════════════════════════════════════════════
            else {
                return {
                    success: false,
                    error: `Template "${params.template_id}" not found. Available: ${Object.keys(CLI_TEMPLATES).join(', ')}`,
                };
            }

            // Apply customizations if provided
            if (params.customizations) {
                await applyTemplateCustomizations(workspacePath, params.customizations);
            }

            // List created files
            const { stdout: lsOutput } = await execAsync(
                "find . -type f -not -path '*/\\.git/*' -not -path '*/node_modules/*' | head -n 30",
                { cwd: workspacePath }
            );

            const fileList = lsOutput
                .trim()
                .split("\n")
                .filter(Boolean)
                .slice(0, 20);

            return {
                success: true,
                template_id: params.template_id,
                template_name: templateName,
                workspace_path: workspacePath,
                method,
                files_created: fileList,
                message: `Template "${templateName}" applied via ${method}.

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

/**
 * Download a GitHub repo as ZIP (faster than git clone, no rate limits)
 */
async function downloadGitHubZip(githubUrl: string, targetPath: string): Promise<void> {
    // Convert https://github.com/user/repo to https://github.com/user/repo/archive/refs/heads/main.zip
    const cleanUrl = githubUrl.replace(/\.git$/, '').replace(/\/$/, '');
    const zipUrl = `${cleanUrl}/archive/refs/heads/main.zip`;

    console.log(`[downloadGitHubZip] Downloading from ${zipUrl}`);

    // Download using curl (more reliable than fetch for large files)
    const zipPath = path.join(targetPath, '..', 'template.zip');

    await execAsync(`curl -L -o "${zipPath}" "${zipUrl}"`, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120000,
    });

    // Extract using unzip
    await execAsync(`unzip -o "${zipPath}" -d "${targetPath}/.."`, {
        maxBuffer: 50 * 1024 * 1024,
    });

    // GitHub zips have a nested folder like "repo-main/", flatten it
    const { stdout: lsOutput } = await execAsync(`ls -d "${targetPath}/../"*/`, {
        cwd: path.dirname(targetPath),
    });

    const extractedDir = lsOutput.trim().split('\n')[0];
    if (extractedDir && extractedDir.includes('-main') || extractedDir.includes('-master')) {
        // Move contents from extracted dir to target
        await execAsync(`mv "${extractedDir}"* "${targetPath}/" || true`, {
            cwd: path.dirname(targetPath),
        });
        // Clean up
        await execAsync(`rm -rf "${extractedDir}" "${zipPath}" || true`);
    } else {
        // Clean up zip
        await execAsync(`rm -f "${zipPath}" || true`);
    }
}

/**
 * Initialize git repo if not already initialized
 */
async function initGitIfNeeded(workspacePath: string): Promise<void> {
    try {
        // Check if .git exists
        await fs.access(path.join(workspacePath, '.git'));
        console.log('[initGitIfNeeded] Git already initialized');
    } catch {
        // Initialize git
        await execAsync('git init', { cwd: workspacePath });
        await execAsync('git add .', { cwd: workspacePath });
        await execAsync('git commit -m "Initial commit from template"', {
            cwd: workspacePath,
        });
        console.log('[initGitIfNeeded] Git initialized');
    }
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
