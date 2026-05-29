/**
 * Diagram Generator
 * =================
 * Converts workspace analysis to graph JSON specs and AI-readable text
 */
import * as path from 'path';
import { WorkspaceAnalysis, AnalyzedFile } from './workspace-analyzer';
import type { GraphSpec } from '@/lib/visual-artifacts/graph-spec';
import { serializeGraphSpec } from '@/lib/visual-artifacts/graph-spec';

function sanitizeId(raw: string): string {
    return raw.replace(/[^a-zA-Z0-9_]/g, '_') || 'node';
}

/**
 * Generate architecture graph spec (nodes + edges JSON).
 */
export function generateArchitectureGraphSpec(analysis: WorkspaceAnalysis): GraphSpec {
    const { language, framework, clusters, entryPoints, dependencies } = analysis;
    const nodes: GraphSpec['nodes'] = [];
    const edges: GraphSpec['edges'] = [];
    const nodeIds = new Set<string>();

    const addNode = (id: string, name: string, color?: string) => {
        const safe = sanitizeId(id);
        if (nodeIds.has(safe)) return safe;
        nodeIds.add(safe);
        nodes.push({
            id: safe,
            name,
            ...(color ? { itemStyle: { color } } : {}),
        });
        return safe;
    };

    const rootId = addNode('project', `${language}${framework ? ` / ${framework}` : ''} project`, '#64748B');

    for (const cluster of clusters.slice(0, 6)) {
        const clusterId = addNode(`cluster_${sanitizeId(cluster.name)}`, cluster.name, '#2563EB');
        edges.push({ source: rootId, target: clusterId });

        for (const filePath of cluster.files.slice(0, 5)) {
            const fileName = path.basename(filePath, path.extname(filePath));
            const file = analysis.files.find(f => f.relativePath === filePath);
            let color = '#3b82f6';
            if (entryPoints.includes(filePath)) color = '#1D9E75';
            else if (file?.type === 'component') color = '#EA580C';
            else if (file?.type === 'model') color = '#DB2777';
            else if (file?.type === 'utility') color = '#7C3AED';

            const fileId = addNode(`${clusterId}_${sanitizeId(fileName)}`, fileName, color);
            edges.push({ source: clusterId, target: fileId });
        }

        if (cluster.files.length > 5) {
            const moreId = addNode(`${clusterId}_more`, `+${cluster.files.length - 5} more`, '#94a3b8');
            edges.push({ source: clusterId, target: moreId });
        }
    }

    const addedEdges = new Set<string>();
    for (const dep of dependencies.slice(0, 15)) {
        const fromName = sanitizeId(path.basename(dep.from, path.extname(dep.from)));
        const toName = sanitizeId(path.basename(dep.to, path.extname(dep.to)));
        const edgeKey = `${fromName}-${toName}`;
        if (!addedEdges.has(edgeKey) && fromName !== toName && nodeIds.has(fromName) && nodeIds.has(toName)) {
            edges.push({ source: fromName, target: toName });
            addedEdges.add(edgeKey);
        }
    }

    return {
        title: `${language} architecture`,
        layout: 'force',
        nodes,
        edges,
    };
}

/** Serialized JSON for DB / context injection. */
export function generateArchitectureDiagram(analysis: WorkspaceAnalysis): string {
    return serializeGraphSpec(generateArchitectureGraphSpec(analysis));
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
 * Count files by type
 */
function countFileTypes(files: AnalyzedFile[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const file of files) {
        counts[file.type] = (counts[file.type] || 0) + 1;
    }
    return counts;
}
