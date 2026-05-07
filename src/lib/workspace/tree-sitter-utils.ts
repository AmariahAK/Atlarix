/**
 * Tree-sitter Utilities
 * =====================
 * Shared Tree-sitter parsing for workspace tools and diagram generation.
 * Both scan_file_structure tool AND DiagramManager import from here.
 */

import * as fs from "fs";
import * as path from "path";
import { parseWithTreeSitter, isTreeSitterAvailable } from "@/lib/analysis/treesitter-parser";

export interface StructureResult {
    imports: string[];
    exports: string[];
    functions: string[];
    classes: string[];
    types?: string[];
    constants?: string[];
}

const MAX_TOKENS_PER_RESULT = 500;

export async function parseFileStructure(
    filePath: string,
    extract: ("imports" | "exports" | "functions" | "classes" | "types" | "constants")[] = ["imports", "exports", "functions", "classes"],
    options?: { workspacePath?: string; relativePath?: string }
): Promise<StructureResult | null> {
    const treeSitterAvailable = await isTreeSitterAvailable();
    if (!treeSitterAvailable) return null;

    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) return null;

        const content = await fs.promises.readFile(filePath, "utf-8");
        const ext = path.extname(filePath);
        const language = ext.replace(".", "");

        const parsed = await parseWithTreeSitter(content, language, filePath, {
            workspacePath: options?.workspacePath,
            relativePath: options?.relativePath,
        });

        if (!parsed) return null;

        const result: StructureResult = {
            imports: parsed.imports ?? [],
            exports: parsed.exports ?? [],
            functions: parsed.functions ?? [],
            classes: parsed.classes ?? [],
        };

        if (extract.includes("types")) {
            (result as any).types = (parsed as any).types ?? [];
        }
        if (extract.includes("constants")) {
            (result as any).constants = (parsed as any).constants ?? [];
        }

        return result;
    } catch {
        return null;
    }
}

export async function parseFileStructureBatch(
    filePaths: string[],
    extract: ("imports" | "exports" | "functions" | "classes" | "types" | "constants")[] = ["imports", "exports", "functions", "classes"]
): Promise<Record<string, StructureResult>> {
    const results: Record<string, StructureResult> = {};

    for (const filePath of filePaths) {
        const result = await parseFileStructure(filePath, extract);
        if (result) {
            results[filePath] = result;
        }
    }

    return results;
}