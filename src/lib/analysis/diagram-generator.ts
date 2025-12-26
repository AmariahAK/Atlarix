/**
 * Diagram Generator
 * =================
 * Converts workspace analysis to Mermaid diagrams and AI-readable text
 * Inspired by StackSense's diagram_to_text.py
 */
import * as path from 'path';
import { WorkspaceAnalysis, Cluster, AnalyzedFile } from './workspace-analyzer';

/**
 * Generate Mermaid architecture diagram
 */
export function generateArchitectureDiagram(analysis: WorkspaceAnalysis): string {
    const { language, framework, clusters, entryPoints, dependencies } = analysis;

    let diagram = `graph TB\n`;
    diagram += `    %% ${language.charAt(0).toUpperCase() + language.slice(1)} project${framework ? ` with ${framework}` : ''}\n\n`;

    // Style definitions for visual appeal
    diagram += `    classDef entryPoint fill:#10b981,stroke:#059669,stroke-width:2px,color:#fff\n`;
    diagram += `    classDef service fill:#3b82f6,stroke:#2563eb,stroke-width:2px,color:#fff\n`;
    diagram += `    classDef component fill:#f59e0b,stroke:#d97706,stroke-width:2px,color:#fff\n`;
    diagram += `    classDef utility fill:#8b5cf6,stroke:#7c3aed,stroke-width:2px,color:#fff\n`;
    diagram += `    classDef model fill:#ec4899,stroke:#db2777,stroke-width:2px,color:#fff\n\n`;

    // Add clusters as subgraphs
    for (const cluster of clusters.slice(0, 6)) { // Max 6 clusters
        const sanitizedId = sanitizeId(cluster.name);
        diagram += `    subgraph ${sanitizedId}["${cluster.name}"]\n`;

        // Show max 5 files per cluster
        for (const filePath of cluster.files.slice(0, 5)) {
            const fileName = path.basename(filePath, path.extname(filePath));
            const nodeId = sanitizeId(fileName);
            diagram += `        ${nodeId}["${fileName}"]\n`;

            // Apply styles based on file type
            const file = analysis.files.find(f => f.relativePath === filePath);
            if (entryPoints.includes(filePath)) {
                diagram += `        class ${nodeId} entryPoint\n`;
            } else if (file?.type === 'component') {
                diagram += `        class ${nodeId} component\n`;
            } else if (file?.type === 'model') {
                diagram += `        class ${nodeId} model\n`;
            } else if (file?.type === 'utility') {
                diagram += `        class ${nodeId} utility\n`;
            } else {
                diagram += `        class ${nodeId} service\n`;
            }
        }

        if (cluster.files.length > 5) {
            diagram += `        ${sanitizedId}_more["... +${cluster.files.length - 5} more"]\n`;
        }

        diagram += `    end\n\n`;
    }

    // Add key dependencies (top 15 most important)
    const addedEdges = new Set<string>();
    for (const dep of dependencies.slice(0, 15)) {
        const fromName = sanitizeId(path.basename(dep.from, path.extname(dep.from)));
        const toName = sanitizeId(path.basename(dep.to, path.extname(dep.to)));

        const edgeKey = `${fromName}-${toName}`;
        if (!addedEdges.has(edgeKey) && fromName !== toName) {
            diagram += `    ${fromName} --> ${toName}\n`;
            addedEdges.add(edgeKey);
        }
    }

    return diagram;
}

/**
 * Generate AI-readable text summary
 */
export function generateTextSummary(
    analysis: WorkspaceAnalysis,
    verbosity: 'small' | 'medium' | 'large' = 'medium'
): string {
    const { language, framework, clusters, files, entryPoints, metadata } = analysis;

    let summary = `# Project Architecture\n\n`;

    // Overview
    summary += `## Overview\n`;
    summary += `- **Language**: ${language}\n`;
    if (framework) {
        summary += `- **Framework**: ${framework}\n`;
    }
    summary += `- **Total Files**: ${metadata.totalFiles}\n`;
    if (entryPoints.length > 0) {
        summary += `- **Entry Points**: ${entryPoints.map(e => path.basename(e)).join(', ')}\n`;
    }
    summary += `\n`;

    // Subsystems/Clusters
    const maxClusters = { small: 3, medium: 5, large: 8 }[verbosity];
    summary += `## Subsystems (${clusters.length})\n\n`;

    for (const cluster of clusters.slice(0, maxClusters)) {
        summary += `### ${cluster.name}\n`;
        summary += `- **Purpose**: ${cluster.purpose}\n`;
        summary += `- **Files**: ${cluster.files.length}\n`;

        if (verbosity !== 'small') {
            const keyFiles = cluster.files.slice(0, 3).map(f => path.basename(f));
            summary += `- **Key**: ${keyFiles.join(', ')}\n`;
        }
        summary += `\n`;
    }

    // Hub files (highly connected)
    if (metadata.hubFiles.length > 0 && verbosity !== 'small') {
        summary += `## Key Components\n`;
        for (const hub of metadata.hubFiles.slice(0, 5)) {
            summary += `- ${path.basename(hub)}\n`;
        }
        summary += `\n`;
    }

    // File type breakdown
    if (verbosity === 'large') {
        const typeCounts = countFileTypes(files);
        summary += `## File Types\n`;
        for (const [type, count] of Object.entries(typeCounts)) {
            summary += `- ${type}: ${count}\n`;
        }
        summary += `\n`;
    }

    return summary;
}

/**
 * Generate compact summary for system prompt injection
 * Keep this VERY brief to avoid token limits
 */
export function generateSystemPromptContext(analysis: WorkspaceAnalysis): string {
    const { language, framework, clusters, entryPoints, metadata } = analysis;

    // Very compact format to minimize tokens
    let context = `\n[WORKSPACE: ${language}`;
    if (framework) context += `/${framework}`;
    context += `, ${metadata.totalFiles} files]\n`;

    // Only show top 3 clusters, one line each
    if (clusters.length > 0) {
        context += `Structure: `;
        context += clusters.slice(0, 3).map(c => `${c.name}(${c.files.length})`).join(', ');
        if (clusters.length > 3) context += `, +${clusters.length - 3} more`;
        context += `\n`;
    }

    // Entry points on one line
    if (entryPoints.length > 0) {
        context += `Entry: ${entryPoints.slice(0, 3).map(e => path.basename(e)).join(', ')}\n`;
    }

    // Hub files on one line
    if (metadata.hubFiles.length > 0) {
        context += `Key: ${metadata.hubFiles.slice(0, 3).map(h => path.basename(h)).join(', ')}\n`;
    }

    return context;
}

/**
 * Sanitize ID for Mermaid node names
 */
function sanitizeId(name: string): string {
    return name
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_') || 'node';
}

/**
 * Count files by type
 */
function countFileTypes(files: AnalyzedFile[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const file of files) {
        counts[file.type] = (counts[file.type] || 0) + 1;
    }
    return counts;
}
