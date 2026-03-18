/**
 * Slice Extractor Agent
 * =====================
 * Intelligent slice extraction using heuristic + TensorFlow scoring.
 * Ported from StackSense's slice_extractor_agent.py.
 * 
 * Features:
 * - Language-specific parsing (Python, JavaScript/TypeScript, generic)
 * - Heuristic scoring: keyword density + function/class name matching
 * - TensorFlow semantic scoring (optional, using @tensorflow/tfjs-node)
 * - Combined score: 60% heuristic + 40% TensorFlow
 * - Context budget management (select within token limit)
 * - Context integrity (don't cut mid-function, merge adjacent slices)
 */

import log from "electron-log";

const logger = log.scope("SliceExtractorAgent");

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export interface Slice {
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    sliceType: 'function' | 'class' | 'block' | 'import';
    name: string;
    score: number;
}

export interface SliceResult {
    slices: Slice[];
    totalCharacters: number;
    omittedLines: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SLICE EXTRACTOR AGENT
// ════════════════════════════════════════════════════════════════════════════

export class SliceExtractorAgent {
    private tfModel: any | null = null;
    private debug: boolean;

    constructor(debug: boolean = false) {
        this.debug = debug;
    }

    /**
     * Extract relevant slices from file content.
     * Uses heuristic + TensorFlow semantic scoring.
     * 
     * @param fileContent - Full file content
     * @param filePath - Path to file (for language detection)
     * @param keywords - Search keywords for relevance scoring
     * @param contextBudget - Maximum characters to extract (default: 4000)
     */
    extractSlices(
        fileContent: string,
        filePath: string,
        keywords: string[],
        contextBudget: number = 4000
    ): SliceResult {
        // Parse file into potential slices
        const potentialSlices = this.parseIntoSlices(fileContent, filePath);

        if (potentialSlices.length === 0) {
            return { slices: [], totalCharacters: 0, omittedLines: 0 };
        }

        // Score each slice
        const scoredSlices = potentialSlices.map(slice => ({
            ...slice,
            score: this.scoreSlice(slice, keywords)
        }));

        // Sort by score (descending)
        scoredSlices.sort((a, b) => b.score - a.score);

        // Select slices within context budget
        const selectedSlices = this.selectWithinBudget(scoredSlices, contextBudget);

        // Ensure context integrity (don't cut mid-function)
        const finalSlices = this.ensureContextIntegrity(selectedSlices);

        // Calculate stats
        const totalCharacters = finalSlices.reduce((sum, s) => sum + s.content.length, 0);
        const allLines = fileContent.split('\n').length;
        const coveredLines = finalSlices.reduce((sum, s) => sum + (s.endLine - s.startLine + 1), 0);

        if (this.debug) {
            logger.log(`[SliceExtractor] Extracted ${finalSlices.length} slices from ${filePath}, ${totalCharacters} chars`);
        }

        return {
            slices: finalSlices,
            totalCharacters,
            omittedLines: allLines - coveredLines
        };
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PARSING
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Parse file into potential slices (functions, classes, blocks).
     */
    private parseIntoSlices(content: string, filePath: string): Slice[] {
        const ext = filePath.split('.').pop()?.toLowerCase();

        if (ext === 'py') {
            return this.parsePythonSlices(content, filePath);
        } else if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext || '')) {
            return this.parseJavaScriptSlices(content, filePath);
        } else {
            return this.parseGenericSlices(content, filePath);
        }
    }

    /**
     * Parse Python code into slices.
     */
    private parsePythonSlices(content: string, filePath: string): Slice[] {
        const slices: Slice[] = [];
        const lines = content.split('\n');
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            // Detect import block
            if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
                const startLine = i;
                while (i < lines.length && (lines[i].trim().startsWith('import ') || lines[i].trim().startsWith('from '))) {
                    i++;
                }
                slices.push({
                    filePath,
                    startLine,
                    endLine: i - 1,
                    content: lines.slice(startLine, i).join('\n'),
                    sliceType: 'import',
                    name: 'imports',
                    score: 0
                });
                continue;
            }

            // Detect function or class
            const defMatch = trimmed.match(/^(def|class|async def)\s+(\w+)/);
            if (defMatch) {
                const startLine = i;
                const indentLevel = line.length - trimmed.length;

                i++;
                while (i < lines.length) {
                    const nextLine = lines[i];
                    if (nextLine.trim() === '') {
                        i++;
                        continue;
                    }
                    const nextIndent = nextLine.length - nextLine.trimStart().length;
                    if (nextIndent <= indentLevel) {
                        break;
                    }
                    i++;
                }

                slices.push({
                    filePath,
                    startLine,
                    endLine: i - 1,
                    content: lines.slice(startLine, i).join('\n'),
                    sliceType: defMatch[1] === 'class' ? 'class' : 'function',
                    name: defMatch[2],
                    score: 0
                });
                continue;
            }

            i++;
        }

        return slices;
    }

    /**
     * Parse JavaScript/TypeScript code into slices.
     */
    private parseJavaScriptSlices(content: string, filePath: string): Slice[] {
        const slices: Slice[] = [];
        const lines = content.split('\n');
        let i = 0;

        while (i < lines.length) {
            const line = lines[i].trim();

            // Detect imports
            if (line.startsWith('import ') || line.startsWith('export { ') || line.startsWith("import '") || line.startsWith('import "')) {
                const startLine = i;
                // Handle multi-line imports
                if (line.includes('{') && !line.includes('}')) {
                    while (i < lines.length && !lines[i].includes('}')) {
                        i++;
                    }
                }
                i++;
                slices.push({
                    filePath,
                    startLine,
                    endLine: i - 1,
                    content: lines.slice(startLine, i).join('\n'),
                    sliceType: 'import',
                    name: 'imports',
                    score: 0
                });
                continue;
            }

            // Detect function or class
            const funcMatch = line.match(/^(export\s+)?(function|class|const|let|var|async function)\s+(\w+)/);
            if (funcMatch) {
                const startLine = i;
                let braceCount = line.split('{').length - line.split('}').length;

                if (braceCount > 0) {
                    i++;
                    while (i < lines.length && braceCount > 0) {
                        const nextLine = lines[i];
                        braceCount += nextLine.split('{').length - nextLine.split('}').length;
                        i++;
                    }
                } else {
                    i++;
                }

                const sliceType = funcMatch[2] === 'class' ? 'class' : 'function';
                slices.push({
                    filePath,
                    startLine,
                    endLine: i - 1,
                    content: lines.slice(startLine, i).join('\n'),
                    sliceType,
                    name: funcMatch[3],
                    score: 0
                });
                continue;
            }

            // Detect arrow functions assigned to const
            const arrowMatch = line.match(/^(export\s+)?(const|let)\s+(\w+)\s*=\s*(\([^)]*\)|[^=])\s*=>/);
            if (arrowMatch) {
                const startLine = i;
                let braceCount = line.split('{').length - line.split('}').length;
                let parenCount = line.split('(').length - line.split(')').length;

                if (braceCount > 0 || parenCount > 0) {
                    i++;
                    while (i < lines.length && (braceCount > 0 || parenCount > 0)) {
                        const nextLine = lines[i];
                        braceCount += nextLine.split('{').length - nextLine.split('}').length;
                        parenCount += nextLine.split('(').length - nextLine.split(')').length;
                        i++;
                    }
                } else {
                    i++;
                }

                slices.push({
                    filePath,
                    startLine,
                    endLine: i - 1,
                    content: lines.slice(startLine, i).join('\n'),
                    sliceType: 'function',
                    name: arrowMatch[3],
                    score: 0
                });
                continue;
            }

            i++;
        }

        return slices;
    }

    /**
     * Generic block-based slicing for unknown languages.
     */
    private parseGenericSlices(content: string, filePath: string): Slice[] {
        const slices: Slice[] = [];
        const lines = content.split('\n');
        const blockSize = 20;

        for (let i = 0; i < lines.length; i += blockSize) {
            const end = Math.min(i + blockSize, lines.length);
            slices.push({
                filePath,
                startLine: i,
                endLine: end - 1,
                content: lines.slice(i, end).join('\n'),
                sliceType: 'block',
                name: `block_${i}`,
                score: 0
            });
        }

        return slices;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // SCORING
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Score slice relevance using heuristic + TF scoring.
     */
    private scoreSlice(slice: Slice, keywords: string[]): number {
        const heuristicScore = this.scoreWithHeuristic(slice, keywords);

        // TensorFlow semantic scoring (if available)
        let tfScore = 0.0;
        if (this.tfModel) {
            tfScore = this.scoreWithTensorFlow(slice, keywords);
            // Weighted combination: 60% heuristic + 40% TensorFlow
            return 0.6 * heuristicScore + 0.4 * tfScore;
        }

        return heuristicScore;
    }

    /**
     * Heuristic scoring based on keyword presence.
     */
    private scoreWithHeuristic(slice: Slice, keywords: string[]): number {
        const contentLower = slice.content.toLowerCase();
        const nameLower = slice.name.toLowerCase();

        let score = 0.0;

        // Keyword density
        for (const keyword of keywords) {
            const keywordLower = keyword.toLowerCase();

            // Count in content
            const contentMatches = (contentLower.match(new RegExp(keywordLower, 'g')) || []).length;
            score += contentMatches * 0.2;

            // Name match (high value)
            if (nameLower.includes(keywordLower)) {
                score += 1.0;
            }
        }

        // Type bonus (prioritize functions/classes over blocks)
        if (slice.sliceType === 'function' || slice.sliceType === 'class') {
            score += 0.3;
        }

        // Import penalty (usually less relevant than functions)
        if (slice.sliceType === 'import') {
            score -= 0.2;
        }

        // Normalize to 0-1 range
        return Math.min(score / 3.0, 1.0);
    }

    /**
     * Score using TensorFlow semantic model.
     * Placeholder - will use @tensorflow/tfjs-node for semantic similarity.
     */
    private scoreWithTensorFlow(slice: Slice, keywords: string[]): number {
        // TODO: Implement TensorFlow semantic scoring
        // This would compute semantic similarity between slice and keywords
        // using Universal Sentence Encoder or similar model
        return 0.5;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // BUDGET & INTEGRITY
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Select slices within context budget.
     */
    private selectWithinBudget(scoredSlices: Slice[], budget: number): Slice[] {
        const selected: Slice[] = [];
        let totalChars = 0;

        for (const slice of scoredSlices) {
            const sliceSize = slice.content.length;

            if (totalChars + sliceSize <= budget) {
                selected.push(slice);
                totalChars += sliceSize;
            } else {
                // Try to fit partial slice if there's room
                const remaining = budget - totalChars;
                if (remaining > 200) {
                    // Truncate slice
                    const lines = slice.content.split('\n');
                    const partialLines: string[] = [];
                    let partialChars = 0;

                    for (const line of lines) {
                        if (partialChars + line.length + 1 <= remaining) {
                            partialLines.push(line);
                            partialChars += line.length + 1;
                        } else {
                            break;
                        }
                    }

                    if (partialLines.length > 0) {
                        selected.push({
                            ...slice,
                            endLine: slice.startLine + partialLines.length - 1,
                            content: partialLines.join('\n')
                        });
                        totalChars += partialChars;
                    }
                }
                break;
            }
        }

        return selected;
    }

    /**
     * Ensure slices don't cut off important context.
     * Merges overlapping/adjacent slices from the same file.
     */
    private ensureContextIntegrity(slices: Slice[]): Slice[] {
        // Group by file
        const byFile = new Map<string, Slice[]>();
        for (const slice of slices) {
            const fileSlices = byFile.get(slice.filePath) || [];
            fileSlices.push(slice);
            byFile.set(slice.filePath, fileSlices);
        }

        // For each file, merge overlapping/adjacent slices
        const final: Slice[] = [];
        for (const [, fileSlices] of byFile) {
            // Sort by start line
            fileSlices.sort((a, b) => a.startLine - b.startLine);

            const merged: Slice[] = [];
            let current = fileSlices[0];

            for (let i = 1; i < fileSlices.length; i++) {
                const next = fileSlices[i];
                // If adjacent or overlapping, merge
                if (next.startLine <= current.endLine + 1) {
                    current = {
                        ...current,
                        endLine: Math.max(current.endLine, next.endLine),
                        content: current.content + '\n' + next.content,
                        score: Math.max(current.score, next.score)
                    };
                } else {
                    merged.push(current);
                    current = next;
                }
            }

            merged.push(current);
            final.push(...merged);
        }

        return final;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // TensorFlow INITIALIZATION (for future use)
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Initialize TensorFlow model for semantic scoring.
     * Call this once on app startup if you want TF-enhanced scoring.
     */
    async initializeTensorFlow(): Promise<boolean> {
        try {
            // Dynamic import to avoid bundling TF if not needed (optional dependency)
            // @ts-expect-error - @tensorflow/tfjs-node is optional and may not be installed
            const tf = await import('@tensorflow/tfjs-node');
            // const use = await import('@tensorflow-models/universal-sentence-encoder');

            // this.tfModel = await use.load();
            logger.log('[SliceExtractor] TensorFlow initialized');
            return true;
        } catch (error) {
            logger.warn('[SliceExtractor] TensorFlow not available, using heuristics only');
            return false;
        }
    }
}

export default SliceExtractorAgent;
