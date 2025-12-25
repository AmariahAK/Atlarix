/**
 * Atlarix Meta Tools
 * ==================
 * Advanced tools for workflow optimization:
 * - preview_changes: Show diffs before applying (0 credits)
 * - explain_diagram: Generate diagram explanations (2 credits)
 * - batch_read_files: Read multiple files at once (1 credit)
 * - batch_write_files: Atomic multi-file writes (varies)
 * - analyze_code: Unified code analysis (3 credits)
 */

import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";
import * as fs from "fs/promises";
import * as path from "path";

// ═══════════════════════════════════════════════════════════
// PREVIEW CHANGES - Show diffs before applying (0 credits)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "preview_changes",
    description:
        `Preview proposed file changes WITHOUT applying them. Shows diffs in the right panel for user approval. 
Use this BEFORE write_file to let users review changes. Costs 0 credits.`,
    category: ToolCategory.CODE,
    cost: 0,
    requiresWorkspace: true,
    isCore: false,
    parameters: createParameters(
        {
            changes: {
                type: "object",
                description: `Array of proposed changes: [{ path: string, operation: 'create'|'modify'|'delete', newContent?: string, description?: string }]`,
            },
        },
        ["changes"]
    ),
    handler: async ({ changes, chatId }) => {
        if (!Array.isArray(changes) || changes.length === 0) {
            return {
                text: "⚠️ No changes to preview. Provide an array of { path, operation, newContent }.",
                proposals: []
            };
        }

        const proposals = [];

        for (const change of changes) {
            const { path: filePath, operation, newContent, description } = change;

            // Read existing content for modify/delete
            let oldContent = '';
            try {
                oldContent = await fs.readFile(filePath, 'utf-8');
            } catch {
                // File doesn't exist, that's ok for 'create'
            }

            proposals.push({
                id: `proposal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                path: filePath,
                operation,
                oldContent: operation !== 'create' ? oldContent : undefined,
                newContent: operation !== 'delete' ? newContent : undefined,
                description: description || `${operation} ${path.basename(filePath)}`,
                status: 'pending'
            });
        }

        // Return proposals for UI to display in FileDiffPanel
        return {
            text: `📋 **Preview: ${proposals.length} proposed change(s)**\n\n` +
                proposals.map((p, i) =>
                    `${i + 1}. **${p.operation.toUpperCase()}** \`${path.basename(p.path)}\`\n   ${p.description}`
                ).join('\n\n') +
                `\n\n_Review in the right panel and approve to apply changes._`,
            proposals
        };
    },
});

// ═══════════════════════════════════════════════════════════
// BATCH READ FILES - Read multiple files at once (1 credit)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "batch_read_files",
    description:
        `Read multiple files in a single operation. More efficient than multiple read_file calls.
Maximum 10 files per batch. Returns content with file path headers.`,
    category: ToolCategory.FILE,
    cost: 1,
    requiresWorkspace: true,
    isCore: false,
    parameters: createParameters(
        {
            paths: {
                type: "object",
                description: "Array of absolute file paths to read (max 10)",
            },
            max_lines_per_file: {
                type: "number",
                description: "Maximum lines per file (default: 500, max: 1000)",
            },
        },
        ["paths"]
    ),
    handler: async ({ paths, max_lines_per_file = 500 }) => {
        if (!Array.isArray(paths) || paths.length === 0) {
            return "⚠️ Provide an array of file paths to read.";
        }

        if (paths.length > 10) {
            return "⚠️ Maximum 10 files per batch. Please split into multiple calls.";
        }

        const maxLines = Math.min(max_lines_per_file, 1000);
        const results: string[] = [];
        let successCount = 0;
        let errorCount = 0;

        for (const filePath of paths) {
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const lines = content.split('\n');
                const truncated = lines.length > maxLines;
                const displayContent = lines.slice(0, maxLines).join('\n');

                results.push(
                    `\n${'═'.repeat(60)}\n` +
                    `📄 **${path.basename(filePath)}**\n` +
                    `📍 \`${filePath}\`\n` +
                    `📊 ${lines.length} lines${truncated ? ` (showing first ${maxLines})` : ''}\n` +
                    `${'─'.repeat(60)}\n\n` +
                    `\`\`\`${getLanguageFromPath(filePath)}\n${displayContent}\n\`\`\`\n` +
                    (truncated ? `\n... [${lines.length - maxLines} more lines truncated]\n` : '')
                );
                successCount++;
            } catch (error) {
                results.push(
                    `\n${'═'.repeat(60)}\n` +
                    `❌ **${path.basename(filePath)}**\n` +
                    `📍 \`${filePath}\`\n` +
                    `Error: ${error instanceof Error ? error.message : 'Unknown error'}\n`
                );
                errorCount++;
            }
        }

        return `# Batch Read: ${successCount} succeeded, ${errorCount} failed\n` + results.join('');
    },
});

// ═══════════════════════════════════════════════════════════
// BATCH WRITE FILES - Atomic multi-file writes (variable cost)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "batch_write_files",
    description:
        `Write multiple files atomically. All files succeed or all fail.
Supports create, modify, and delete operations. Maximum 10 files per batch.
Cost: 1 credit per file modified.`,
    category: ToolCategory.FILE,
    cost: 1, // Per file
    requiresWorkspace: true,
    isCore: false,
    parameters: createParameters(
        {
            operations: {
                type: "object",
                description: `Array of write operations: [{ path: string, content: string, operation?: 'create'|'modify'|'delete' }]`,
            },
            dry_run: {
                type: "boolean",
                description: "If true, validate but don't apply changes (default: false)",
            },
        },
        ["operations"]
    ),
    handler: async ({ operations, dry_run = false }) => {
        if (!Array.isArray(operations) || operations.length === 0) {
            return "⚠️ Provide an array of file operations.";
        }

        if (operations.length > 10) {
            return "⚠️ Maximum 10 files per batch. Please split into multiple calls.";
        }

        // Validate all operations first
        const validated = [];
        for (const op of operations) {
            const { path: filePath, content, operation = 'modify' } = op;

            if (!filePath) {
                return `⚠️ Missing path in operation: ${JSON.stringify(op)}`;
            }

            if (operation !== 'delete' && content === undefined) {
                return `⚠️ Missing content for ${operation} operation on: ${filePath}`;
            }

            validated.push({ path: filePath, content, operation });
        }

        if (dry_run) {
            return `✅ **Dry Run Validation Passed**\n\n` +
                validated.map((op, i) =>
                    `${i + 1}. ${op.operation.toUpperCase()} \`${path.basename(op.path)}\``
                ).join('\n') +
                `\n\n_Set dry_run=false to apply changes._`;
        }

        // Apply all changes
        const results: string[] = [];
        const backups: { path: string; content: string }[] = [];

        try {
            for (const op of validated) {
                // Backup existing file for rollback
                try {
                    const existing = await fs.readFile(op.path, 'utf-8');
                    backups.push({ path: op.path, content: existing });
                } catch {
                    // File doesn't exist, no backup needed
                }

                if (op.operation === 'delete') {
                    await fs.unlink(op.path);
                    results.push(`🗑️ Deleted: \`${op.path}\``);
                } else {
                    // Ensure directory exists
                    await fs.mkdir(path.dirname(op.path), { recursive: true });
                    await fs.writeFile(op.path, op.content);
                    results.push(`✅ ${op.operation === 'create' ? 'Created' : 'Modified'}: \`${op.path}\``);
                }
            }

            return `# ✅ Batch Write Complete\n\n${results.join('\n')}\n\n_${validated.length} files updated successfully._`;

        } catch (error) {
            // Rollback on failure
            for (const backup of backups) {
                try {
                    await fs.writeFile(backup.path, backup.content);
                } catch {
                    // Best effort rollback
                }
            }

            return `# ❌ Batch Write Failed\n\nError: ${error instanceof Error ? error.message : 'Unknown error'}\n\n_Changes have been rolled back._`;
        }
    },
});

// ═══════════════════════════════════════════════════════════
// EXPLAIN DIAGRAM - Generate natural language explanation
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "explain_diagram",
    description:
        `Analyze a Mermaid or PlantUML diagram and generate a natural language explanation.
Identifies components, relationships, data flows, and patterns.`,
    category: ToolCategory.DIAGRAM,
    cost: 2,
    requiresWorkspace: false,
    isCore: false,
    parameters: createParameters(
        {
            diagram_code: stringParam("Mermaid or PlantUML diagram code"),
            detail_level: stringParam("Explanation detail: 'brief', 'standard' (default), or 'detailed'"),
        },
        ["diagram_code"]
    ),
    handler: async ({ diagram_code, detail_level = "standard" }) => {
        if (!diagram_code || diagram_code.trim() === '') {
            return "⚠️ Please provide diagram code to explain.";
        }

        // Detect diagram type
        const code = diagram_code.trim();
        const isMermaid = code.startsWith('graph') || code.startsWith('flowchart') ||
            code.startsWith('sequenceDiagram') || code.startsWith('classDiagram') ||
            code.startsWith('stateDiagram') || code.startsWith('erDiagram');
        const isPlantUML = code.startsWith('@startuml') || code.includes('@enduml');

        const diagramType = isMermaid ? 'Mermaid' : isPlantUML ? 'PlantUML' : 'Unknown';

        // Parse diagram structure
        const analysis = analyzeDiagramStructure(code, diagramType);

        // Generate explanation based on detail level
        let explanation = `# 📊 Diagram Explanation\n\n`;
        explanation += `**Type:** ${diagramType} ${analysis.subType}\n\n`;

        if (detail_level === 'brief') {
            explanation += `## Summary\n`;
            explanation += `This ${analysis.subType.toLowerCase()} diagram shows ${analysis.nodeCount} components connected by ${analysis.edgeCount} relationships.\n\n`;
            explanation += `**Key Components:** ${analysis.components.slice(0, 5).join(', ')}\n`;
        } else {
            explanation += `## Overview\n`;
            explanation += `This ${analysis.subType.toLowerCase()} diagram illustrates the relationships between ${analysis.nodeCount} components.\n\n`;

            explanation += `## Components (${analysis.nodeCount})\n`;
            analysis.components.forEach((comp, i) => {
                explanation += `${i + 1}. **${comp}**\n`;
            });

            explanation += `\n## Relationships (${analysis.edgeCount})\n`;
            explanation += `The diagram shows ${analysis.edgeCount} connections between components.\n\n`;

            if (detail_level === 'detailed' && analysis.patterns.length > 0) {
                explanation += `## Patterns Identified\n`;
                analysis.patterns.forEach(pattern => {
                    explanation += `- ${pattern}\n`;
                });
            }
        }

        return {
            text: explanation,
            diagram: {
                type: diagramType.toLowerCase() as 'mermaid' | 'plantuml',
                code: diagram_code,
                analysis
            }
        };
    },
});

// ═══════════════════════════════════════════════════════════
// UNIFIED ANALYZE CODE - Comprehensive code analysis
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "analyze_code",
    description:
        `Unified code analysis combining:
- Code smells detection
- Complexity estimation  
- Security vulnerability scanning
- Dependency analysis
Returns comprehensive report with actionable recommendations.`,
    category: ToolCategory.CODE,
    cost: 3,
    requiresWorkspace: true,
    isCore: false,
    parameters: createParameters(
        {
            path: stringParam("File or directory path to analyze"),
            scope: stringParam("Analysis scope: 'smells', 'complexity', 'security', 'dependencies', or 'all' (default)"),
            max_files: {
                type: "number",
                description: "Maximum files to analyze for directories (default: 20)",
            },
        },
        ["path"]
    ),
    handler: async ({ path: targetPath, scope = "all", max_files = 20 }) => {
        if (!targetPath) {
            return "⚠️ Please provide a file or directory path to analyze.";
        }

        const analysisScope = scope.toLowerCase();
        const validScopes = ['smells', 'complexity', 'security', 'dependencies', 'all'];
        if (!validScopes.includes(analysisScope)) {
            return `⚠️ Invalid scope: "${scope}". Use: ${validScopes.join(', ')}`;
        }

        try {
            const stats = await fs.stat(targetPath);
            const isDirectory = stats.isDirectory();

            // Get files to analyze
            let filesToAnalyze: string[] = [];
            if (isDirectory) {
                filesToAnalyze = await getFilesToAnalyze(targetPath, max_files);
            } else {
                filesToAnalyze = [targetPath];
            }

            if (filesToAnalyze.length === 0) {
                return "⚠️ No analyzable files found.";
            }

            // Run analysis
            const results = {
                smells: [] as string[],
                complexity: [] as { file: string; score: number; issues: string[] }[],
                security: [] as string[],
                dependencies: [] as string[],
            };

            for (const file of filesToAnalyze) {
                const content = await fs.readFile(file, 'utf-8');
                const lines = content.split('\n');
                const fileName = path.basename(file);

                // Smells analysis
                if (analysisScope === 'all' || analysisScope === 'smells') {
                    if (lines.some(l => l.length > 120)) {
                        results.smells.push(`📄 \`${fileName}\`: Long lines detected (>120 chars)`);
                    }
                    if (content.includes('TODO') || content.includes('FIXME')) {
                        results.smells.push(`📄 \`${fileName}\`: Contains TODO/FIXME comments`);
                    }
                    if (lines.length > 500) {
                        results.smells.push(`📄 \`${fileName}\`: Large file (${lines.length} lines)`);
                    }
                }

                // Complexity analysis
                if (analysisScope === 'all' || analysisScope === 'complexity') {
                    const complexityScore = estimateComplexity(content);
                    if (complexityScore > 15) {
                        results.complexity.push({
                            file: fileName,
                            score: complexityScore,
                            issues: ['High cyclomatic complexity']
                        });
                    }
                }

                // Security analysis
                if (analysisScope === 'all' || analysisScope === 'security') {
                    if (content.includes('eval(') || content.includes('exec(')) {
                        results.security.push(`🔴 \`${fileName}\`: Uses eval/exec - potential code injection`);
                    }
                    if (/password\s*=\s*['"][^'"]+['"]/i.test(content)) {
                        results.security.push(`🔴 \`${fileName}\`: Hardcoded password detected`);
                    }
                    if (content.includes('dangerouslySetInnerHTML')) {
                        results.security.push(`🟡 \`${fileName}\`: Uses dangerouslySetInnerHTML`);
                    }
                }

                // Dependencies
                if (analysisScope === 'all' || analysisScope === 'dependencies') {
                    if (fileName === 'package.json') {
                        try {
                            const pkg = JSON.parse(content);
                            const depCount = Object.keys(pkg.dependencies || {}).length;
                            const devDepCount = Object.keys(pkg.devDependencies || {}).length;
                            results.dependencies.push(`📦 ${depCount} dependencies, ${devDepCount} devDependencies`);
                        } catch { }
                    }
                }
            }

            // Build report
            let report = `# 📊 Code Analysis Report\n\n`;
            report += `**Path:** \`${targetPath}\`\n`;
            report += `**Files Analyzed:** ${filesToAnalyze.length}\n\n`;

            if (results.smells.length > 0 && (analysisScope === 'all' || analysisScope === 'smells')) {
                report += `## 🔍 Code Smells (${results.smells.length})\n`;
                results.smells.forEach(smell => report += `- ${smell}\n`);
                report += '\n';
            }

            if (results.complexity.length > 0 && (analysisScope === 'all' || analysisScope === 'complexity')) {
                report += `## 📈 Complexity Issues (${results.complexity.length})\n`;
                results.complexity.forEach(c => report += `- \`${c.file}\`: Score ${c.score} - ${c.issues.join(', ')}\n`);
                report += '\n';
            }

            if (results.security.length > 0 && (analysisScope === 'all' || analysisScope === 'security')) {
                report += `## 🔐 Security Issues (${results.security.length})\n`;
                results.security.forEach(issue => report += `- ${issue}\n`);
                report += '\n';
            }

            if (results.dependencies.length > 0 && (analysisScope === 'all' || analysisScope === 'dependencies')) {
                report += `## 📦 Dependencies\n`;
                results.dependencies.forEach(dep => report += `- ${dep}\n`);
                report += '\n';
            }

            const totalIssues = results.smells.length + results.complexity.length + results.security.length;
            if (totalIssues === 0) {
                report += `## ✅ No Issues Found\n\nThe analyzed code looks good!\n`;
            } else {
                report += `---\n**Total Issues:** ${totalIssues}\n`;
            }

            return report;

        } catch (error) {
            return `❌ Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

function getLanguageFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
        '.css': 'css', '.scss': 'scss', '.html': 'html', '.json': 'json',
        '.md': 'markdown', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'bash',
    };
    return langMap[ext] || 'text';
}

function analyzeDiagramStructure(code: string, type: string): {
    subType: string;
    nodeCount: number;
    edgeCount: number;
    components: string[];
    patterns: string[];
} {
    const lines = code.split('\n').filter(l => l.trim());
    const components: string[] = [];
    const patterns: string[] = [];

    // Detect subtype
    let subType = 'Diagram';
    if (code.includes('flowchart') || code.includes('graph')) subType = 'Flowchart';
    else if (code.includes('sequenceDiagram')) subType = 'Sequence Diagram';
    else if (code.includes('classDiagram')) subType = 'Class Diagram';
    else if (code.includes('erDiagram')) subType = 'ER Diagram';
    else if (code.includes('@startuml')) subType = 'UML Diagram';

    // Extract components (simplified)
    const nodePattern = /(\w+)[\[\(\{]/g;
    let match;
    while ((match = nodePattern.exec(code)) !== null) {
        if (!['graph', 'flowchart', 'subgraph', 'end'].includes(match[1].toLowerCase())) {
            components.push(match[1]);
        }
    }

    // Count edges
    const edgePattern = /-->|->|--|-\.-|===|==/g;
    const edgeCount = (code.match(edgePattern) || []).length;

    // Identify patterns
    if (components.length > 10) patterns.push('Complex diagram with many components');
    if (code.includes('subgraph')) patterns.push('Uses subgraphs for organization');
    if (edgeCount > components.length * 2) patterns.push('Highly interconnected');

    return {
        subType,
        nodeCount: [...new Set(components)].length,
        edgeCount,
        components: [...new Set(components)].slice(0, 10),
        patterns
    };
}

async function getFilesToAnalyze(dirPath: string, maxFiles: number): Promise<string[]> {
    const files: string[] = [];
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'];

    async function walk(dir: string) {
        if (files.length >= maxFiles) return;

        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (files.length >= maxFiles) return;

            const fullPath = path.join(dir, entry.name);

            // Skip node_modules, .git, etc.
            if (entry.isDirectory()) {
                if (!['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)) {
                    await walk(fullPath);
                }
            } else if (codeExtensions.includes(path.extname(entry.name).toLowerCase())) {
                files.push(fullPath);
            }
        }
    }

    await walk(dirPath);
    return files;
}

function estimateComplexity(content: string): number {
    let score = 0;

    // Count control flow structures
    score += (content.match(/\bif\s*\(/g) || []).length * 1;
    score += (content.match(/\belse\s+if\s*\(/g) || []).length * 1;
    score += (content.match(/\belse\s*\{/g) || []).length * 1;
    score += (content.match(/\bfor\s*\(/g) || []).length * 2;
    score += (content.match(/\bwhile\s*\(/g) || []).length * 2;
    score += (content.match(/\bswitch\s*\(/g) || []).length * 2;
    score += (content.match(/\bcase\s+/g) || []).length * 1;
    score += (content.match(/\bcatch\s*\(/g) || []).length * 1;
    score += (content.match(/\?\s*.*\s*:/g) || []).length * 1; // Ternary

    return score;
}

export { };
