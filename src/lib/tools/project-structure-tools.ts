/**
 * Project Structure Tools
 * =======================
 * Tools for understanding project structure without diagrams
 * Part of the Multi-Layer Fallback System
 */

import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";

// ═══════════════════════════════════════════════════════════
// FRAMEWORK DETECTION
// ═══════════════════════════════════════════════════════════

interface FrameworkInfo {
    name: string;
    confidence: 'high' | 'medium' | 'low';
    indicators: string[];
}

function detectFramework(workspacePath: string, files: string[]): FrameworkInfo {
    const hasFile = (name: string) => files.some(f => f === name || f.endsWith('/' + name));
    const hasDir = (name: string) => files.some(f => f.startsWith(name + '/'));

    // Check for common frameworks
    const indicators: string[] = [];

    // Next.js
    if (hasFile('next.config.js') || hasFile('next.config.mjs') || hasFile('next.config.ts')) {
        indicators.push('next.config found');
        if (hasDir('app') || hasDir('pages')) {
            indicators.push('app/pages directory');
            return { name: 'Next.js', confidence: 'high', indicators };
        }
        return { name: 'Next.js', confidence: 'medium', indicators };
    }

    // React (Vite or CRA)
    if (hasFile('vite.config.ts') || hasFile('vite.config.js')) {
        indicators.push('vite.config found');
        if (files.some(f => f.endsWith('.tsx') || f.endsWith('.jsx'))) {
            indicators.push('React components (.tsx/.jsx)');
            return { name: 'React (Vite)', confidence: 'high', indicators };
        }
        return { name: 'Vite', confidence: 'medium', indicators };
    }

    if (hasDir('src') && (hasFile('src/App.tsx') || hasFile('src/App.jsx') || hasFile('src/App.js'))) {
        indicators.push('src/App component');
        return { name: 'React', confidence: 'high', indicators };
    }

    // Vue
    if (hasFile('vue.config.js') || files.some(f => f.endsWith('.vue'))) {
        indicators.push('.vue files found');
        return { name: 'Vue.js', confidence: 'high', indicators };
    }

    // Angular
    if (hasFile('angular.json')) {
        indicators.push('angular.json found');
        return { name: 'Angular', confidence: 'high', indicators };
    }

    // Express/Node backend
    if (hasFile('server.js') || hasFile('server.ts') || hasFile('app.js') || hasFile('app.ts')) {
        indicators.push('server/app entry point');
        if (hasDir('routes') || hasDir('controllers')) {
            indicators.push('routes/controllers directory');
            return { name: 'Express.js', confidence: 'high', indicators };
        }
        return { name: 'Node.js Backend', confidence: 'medium', indicators };
    }

    // Python
    if (hasFile('requirements.txt') || hasFile('pyproject.toml') || hasFile('setup.py')) {
        indicators.push('Python package files');
        if (hasFile('manage.py')) {
            return { name: 'Django', confidence: 'high', indicators };
        }
        if (hasFile('app.py') || hasFile('main.py')) {
            if (files.some(f => f.includes('flask'))) {
                return { name: 'Flask', confidence: 'medium', indicators };
            }
            if (files.some(f => f.includes('fastapi'))) {
                return { name: 'FastAPI', confidence: 'medium', indicators };
            }
        }
        return { name: 'Python', confidence: 'medium', indicators };
    }

    // Electron
    if (hasFile('electron.vite.config.ts') || hasFile('forge.config.ts')) {
        indicators.push('Electron config found');
        return { name: 'Electron', confidence: 'high', indicators };
    }

    // Basic checks
    if (hasFile('package.json')) {
        indicators.push('package.json found');
        return { name: 'Node.js', confidence: 'low', indicators };
    }

    if (hasFile('Cargo.toml')) {
        indicators.push('Cargo.toml found');
        return { name: 'Rust', confidence: 'high', indicators };
    }

    if (hasFile('go.mod')) {
        indicators.push('go.mod found');
        return { name: 'Go', confidence: 'high', indicators };
    }

    return { name: 'Unknown', confidence: 'low', indicators: [] };
}

// ═══════════════════════════════════════════════════════════
// GET PROJECT STRUCTURE - ENHANCED
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "get_project_structure",
    category: ToolCategory.FILE,
    description: "Get project overview with framework detection. Use FIRST when exploring a workspace.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            max_depth: {
                type: "number",
                description: "Maximum depth to scan (default: 3, max: 5)",
            },
            include_counts: {
                type: "boolean",
                description: "Include file counts per folder (default: true)",
            },
        },
        []
    ),
    handler: async ({ max_depth = 3, include_counts = true, workspace }) => {
        try {
            if (!workspace) {
                throw new Error("No workspace path provided");
            }

            const maxDepth = Math.min(max_depth, 5);

            // Get all files
            const files = await glob("**/*", {
                cwd: workspace,
                ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", ".next/**", "venv/**", "__pycache__/**", "*.lock"],
                dot: false,
                maxDepth: maxDepth,
            });

            // Detect framework
            const framework = detectFramework(workspace, files);

            // Count files by extension
            const extCounts: Record<string, number> = {};
            files.forEach(f => {
                const ext = path.extname(f).toLowerCase() || '(no ext)';
                extCounts[ext] = (extCounts[ext] || 0) + 1;
            });

            // Get top-level folders with counts
            const folderCounts: Record<string, number> = {};
            files.forEach(f => {
                const parts = f.split('/');
                if (parts.length > 1) {
                    folderCounts[parts[0]] = (folderCounts[parts[0]] || 0) + 1;
                }
            });

            // Find key/config files
            const keyFiles = files.filter(f =>
                /^(package\.json|tsconfig.*|vite\.config|next\.config|\.env|README|Dockerfile)/i.test(path.basename(f))
            ).slice(0, 10);

            // Find entry points
            const entryPoints = files.filter(f =>
                /(^|\/)?(main|index|app|server)\.(ts|tsx|js|jsx|py)$/i.test(f)
            ).slice(0, 5);

            // Build output
            let output = `# Project Overview\n\n`;
            output += `**Framework:** ${framework.name} (${framework.confidence} confidence)\n`;
            if (framework.indicators.length > 0) {
                output += `**Detected via:** ${framework.indicators.join(', ')}\n`;
            }
            output += `**Total Files:** ${files.length}\n\n`;

            // Main folders
            output += `## Main Folders\n`;
            const sortedFolders = Object.entries(folderCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);

            sortedFolders.forEach(([folder, count]) => {
                output += include_counts
                    ? `- 📁 ${folder}/ (${count} files)\n`
                    : `- 📁 ${folder}/\n`;
            });

            // Entry Points
            if (entryPoints.length > 0) {
                output += `\n## Entry Points\n`;
                entryPoints.forEach(f => output += `- ${f}\n`);
            }

            // Key Config Files
            if (keyFiles.length > 0) {
                output += `\n## Config Files\n`;
                keyFiles.forEach(f => output += `- ${f}\n`);
            }

            // File Types
            output += `\n## File Types\n`;
            const sortedExts = Object.entries(extCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8);
            sortedExts.forEach(([ext, count]) => {
                output += `- ${ext}: ${count} files\n`;
            });

            output += `\n---\n💡 **Next Steps:**\n`;
            output += `- Use \`find_relevant_files\` to find specific features\n`;
            output += `- Use \`search_code\` to find code patterns\n`;
            output += `- Use \`read_file\` to view specific files\n`;

            return output;
        } catch (error) {
            throw new Error(`Failed to get project structure: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// FIND RELEVANT FILES - KEYWORD SEARCH
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "find_relevant_files",
    category: ToolCategory.FILE,
    description: `Find files related to a feature or bug by keyword search.
Use when you need to locate code for a specific task without a diagram.
Searches file names, paths, and optionally file contents for matches.`,
    cost: 2,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            query: stringParam("Keywords to search for (e.g., 'login button', 'authentication', 'api routes')"),
            file_types: stringParam("Optional: File extensions to include (e.g., '.tsx,.ts')"),
            search_contents: {
                type: "boolean",
                description: "Also search inside files for the query (slower but more thorough). Default: false",
            },
            max_results: {
                type: "number",
                description: "Maximum results to return (default: 15, max: 30)",
            },
        },
        ["query"]
    ),
    handler: async ({ query, file_types, search_contents = false, max_results = 15, workspace }) => {
        try {
            if (!workspace) {
                throw new Error("No workspace path provided");
            }
            if (!query) {
                throw new Error("Missing required parameter: query");
            }

            max_results = Math.min(max_results, 30);

            // Get all files
            const files = await glob("**/*.*", {
                cwd: workspace,
                ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", ".next/**", "venv/**", "__pycache__/**"],
                dot: false,
                maxDepth: 6,
            });

            // Parse file types filter
            const allowedExts = file_types
                ? file_types.split(',').map((e: string) => e.trim().toLowerCase())
                : null;

            // Split query into keywords
            const keywords = query.toLowerCase().split(/\s+/).filter((k: string) => k.length > 1);

            interface FileMatch {
                path: string;
                score: number;
                reasons: string[];
            }

            const matches: FileMatch[] = [];

            for (const file of files) {
                // Filter by extension if specified
                const ext = path.extname(file).toLowerCase();
                if (allowedExts && !allowedExts.some((e: string) => ext === e || ext === '.' + e)) {
                    continue;
                }

                const fileName = path.basename(file).toLowerCase();
                const filePath = file.toLowerCase();
                let score = 0;
                const reasons: string[] = [];

                // Score based on file name matches
                for (const keyword of keywords) {
                    if (fileName.includes(keyword)) {
                        score += 10;
                        reasons.push(`filename contains '${keyword}'`);
                    } else if (filePath.includes(keyword)) {
                        score += 5;
                        reasons.push(`path contains '${keyword}'`);
                    }
                }

                // Search file contents if enabled and file hasn't matched yet
                if (search_contents && score === 0) {
                    try {
                        const fullPath = path.join(workspace, file);
                        const stat = await fs.promises.stat(fullPath);

                        // Only search small text files
                        if (stat.size < 100000 && stat.isFile()) {
                            const content = await fs.promises.readFile(fullPath, 'utf-8');
                            const contentLower = content.toLowerCase();

                            for (const keyword of keywords) {
                                if (contentLower.includes(keyword)) {
                                    score += 3;
                                    reasons.push(`contains '${keyword}'`);
                                }
                            }
                        }
                    } catch {
                        // Skip unreadable files
                    }
                }

                if (score > 0) {
                    matches.push({ path: file, score, reasons });
                }
            }

            // Sort by score and limit
            matches.sort((a, b) => b.score - a.score);
            const topMatches = matches.slice(0, max_results);

            if (topMatches.length === 0) {
                return `No files found matching: "${query}"\n\nTry:\n- Different keywords\n- Enabling search_contents: true\n- Using search_code for exact patterns`;
            }

            let output = `Found ${topMatches.length} file(s) related to "${query}":\n\n`;

            topMatches.forEach((m, i) => {
                output += `${i + 1}. **${m.path}**\n`;
                output += `   Relevance: ${m.reasons.slice(0, 3).join(', ')}\n\n`;
            });

            output += `---\n💡 Use \`read_file\` to examine promising files.`;

            return output;
        } catch (error) {
            throw new Error(`Failed to find relevant files: ${error}`);
        }
    },
});
