/**
 * PASS7.2: Tree-sitter native packages removed. These helpers are stubs —
 * `parseFileStructure` always returns null; consumers use regex/heuristics
 * elsewhere (e.g. workspace-analyzer) when needed.
 */

export interface StructureResult {
    imports: string[];
    exports: string[];
    functions: string[];
    classes: string[];
    types?: string[];
    constants?: string[];
}

export async function parseFileStructure(
    _filePath: string,
    _extract: ("imports" | "exports" | "functions" | "classes" | "types" | "constants")[] = ["imports", "exports", "functions", "classes"],
    _options?: { workspacePath?: string; relativePath?: string },
): Promise<StructureResult | null> {
    return null;
}

export async function parseFileStructureBatch(
    filePaths: string[],
    extract: ("imports" | "exports" | "functions" | "classes" | "types" | "constants")[] = ["imports", "exports", "functions", "classes"],
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
