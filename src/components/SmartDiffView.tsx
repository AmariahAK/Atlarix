/**
 * SmartDiffView
 * =============
 * Compact diff display with:
 * - Hunks with ±3 lines of context
 * - Expand All button for full view
 * - AI-generated summary at top
 * - Syntax-aware display (file extension for future highlighting)
 */

import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { FileEdit, ChevronDown, ChevronUp } from "lucide-react";

const CONTEXT_LINES = 3;
const HUNK_THRESHOLD = 50;

type DiffLineType = { type: "context" | "add" | "remove" | "header"; content: string; oldLineNum?: number; newLineNum?: number };

function DiffLineRow({ line }: { line: DiffLineType }) {
    return (
        <div
            className={cn("flex", line.type === "header" && "bg-muted/50 border-b border-border")}
            style={{
                backgroundColor: line.type === "add" ? "var(--diff-add-bg)" : line.type === "remove" ? "var(--diff-remove-bg)" : undefined,
            }}
        >
            {line.type !== "header" && (
                <div className="flex shrink-0 select-none">
                    <span
                        className="w-10 text-right px-1 border-r border-border/30"
                        style={{ color: line.type === "add" ? "var(--diff-add-line)" : line.type === "remove" ? "var(--diff-remove-line)" : "var(--diff-context-text)" }}
                    >
                        {line.type !== "add" ? line.oldLineNum : ""}
                    </span>
                    <span
                        className="w-10 text-right px-1 border-r border-border/30"
                        style={{ color: line.type === "add" ? "var(--diff-add-line)" : line.type === "remove" ? "var(--diff-remove-line)" : "var(--diff-context-text)" }}
                    >
                        {line.type !== "remove" ? line.newLineNum : ""}
                    </span>
                </div>
            )}
            <div className="flex-1 flex min-w-0">
                <span
                    className="w-5 text-center select-none shrink-0 font-bold"
                    style={{ color: line.type === "add" ? "var(--diff-add-text)" : line.type === "remove" ? "var(--diff-remove-text)" : "var(--diff-context-text)" }}
                >
                    {line.type === "add" && "+"}
                    {line.type === "remove" && "-"}
                    {line.type === "context" && " "}
                </span>
                <pre className="flex-1 whitespace-pre-wrap break-words px-2 py-0.5 text-xs overflow-x-auto">
                    {line.content || " "}
                </pre>
            </div>
        </div>
    );
}

function generateDiffLines(oldContent: string, newContent: string, path: string, operation: "create" | "update" | "delete"): DiffLineType[] {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const lines: DiffLineType[] = [];

    if (operation === "create") {
        lines.push({ type: "header", content: `+++ ${path} (new file)` });
        newLines.forEach((line, i) => lines.push({ type: "add", content: line, newLineNum: i + 1 }));
        return lines;
    }

    if (operation === "delete") {
        lines.push({ type: "header", content: `--- ${path} (deleted)` });
        oldLines.forEach((line, i) => lines.push({ type: "remove", content: line, oldLineNum: i + 1 }));
        return lines;
    }

    // Modify: prefix/suffix diff
    lines.push({ type: "header", content: `--- ${path}` });
    lines.push({ type: "header", content: `+++ ${path}` });

    let prefixLen = 0;
    while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
        prefixLen++;
    }
    let suffixLen = 0;
    while (
        suffixLen < oldLines.length - prefixLen &&
        suffixLen < newLines.length - prefixLen &&
        oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
    ) {
        suffixLen++;
    }

    const contextBefore = Math.max(0, prefixLen - CONTEXT_LINES);
    for (let i = contextBefore; i < prefixLen; i++) {
        lines.push({ type: "context", content: oldLines[i], oldLineNum: i + 1, newLineNum: i + 1 });
    }
    for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
        lines.push({ type: "remove", content: oldLines[i], oldLineNum: i + 1 });
    }
    for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
        lines.push({ type: "add", content: newLines[i], newLineNum: i + 1 });
    }
    const contextAfterStart = Math.max(oldLines.length - suffixLen, 0);
    const contextAfterEnd = Math.min(contextAfterStart + CONTEXT_LINES, oldLines.length);
    for (let i = contextAfterStart; i < contextAfterEnd; i++) {
        const newI = newLines.length - (oldLines.length - i);
        lines.push({ type: "context", content: oldLines[i], oldLineNum: i + 1, newLineNum: newI + 1 });
    }
    return lines;
}

function splitIntoHunks(nonHeaderLines: DiffLineType[], contextLines: number): DiffLineType[][] {
    const hunks: DiffLineType[][] = [];
    let i = 0;
    while (i < nonHeaderLines.length) {
        const hunk: DiffLineType[] = [];
        let contextCount = 0;
        while (i < nonHeaderLines.length && nonHeaderLines[i].type === "context" && contextCount < contextLines) {
            hunk.push(nonHeaderLines[i]);
            i++;
            contextCount++;
        }
        while (i < nonHeaderLines.length && nonHeaderLines[i].type === "context") i++;
        while (i < nonHeaderLines.length && (nonHeaderLines[i].type === "add" || nonHeaderLines[i].type === "remove")) {
            hunk.push(nonHeaderLines[i]);
            i++;
        }
        let trail = 0;
        while (i < nonHeaderLines.length && nonHeaderLines[i].type === "context" && trail < contextLines) {
            hunk.push(nonHeaderLines[i]);
            i++;
            trail++;
        }
        while (i < nonHeaderLines.length && nonHeaderLines[i].type === "context") i++;
        if (hunk.length > 0) hunks.push(hunk);
    }
    return hunks;
}

export interface SmartDiffViewProps {
    path: string;
    oldContent: string;
    newContent: string;
    description?: string;
    operation?: "create" | "update" | "delete";
    maxHeight?: string;
}

export function SmartDiffView({
    path,
    oldContent,
    newContent,
    description,
    operation = "update",
    maxHeight = "max-h-64",
}: SmartDiffViewProps) {
    const [expandAll, setExpandAll] = useState(false);

    const diffLines = useMemo(
        () => generateDiffLines(oldContent, newContent, path, operation),
        [oldContent, newContent, path, operation]
    );

    const headerLines = diffLines.filter((l) => l.type === "header");
    const nonHeaderLines = diffLines.filter((l): l is DiffLineType => l.type !== "header");
    const hunks = splitIntoHunks(nonHeaderLines, CONTEXT_LINES);
    const useHunks = !expandAll && diffLines.length > HUNK_THRESHOLD && hunks.length > 0;

    const addedCount = diffLines.filter((l) => l.type === "add").length;
    const removedCount = diffLines.filter((l) => l.type === "remove").length;

    return (
        <div className={cn("flex flex-col rounded-lg border border-border overflow-hidden", maxHeight)}>
            {description && (
                <div className="px-3 py-2 bg-muted/50 border-b border-border">
                    <p className="text-xs font-medium text-muted-foreground mb-0.5">Summary</p>
                    <p className="text-sm text-foreground">{description}</p>
                </div>
            )}
            <div className="flex items-center justify-between px-2 py-1.5 bg-muted/30 border-b border-border">
                <div className="flex items-center gap-2 min-w-0">
                    <FileEdit className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium truncate">{path.split("/").pop()}</span>
                    <span
                        className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded capitalize shrink-0",
                            operation === "create" && "bg-green-500/20 text-green-500",
                            operation === "update" && "bg-yellow-500/20 text-yellow-500",
                            operation === "delete" && "bg-red-500/20 text-red-500"
                        )}
                    >
                        {operation}
                    </span>
                </div>
                <div className="flex items-center gap-2 shrink-0 text-[10px]">
                    {addedCount > 0 && <span style={{ color: "var(--diff-add-text)" }}>+{addedCount}</span>}
                    {removedCount > 0 && <span style={{ color: "var(--diff-remove-text)" }}>-{removedCount}</span>}
                    {diffLines.length > HUNK_THRESHOLD && (
                        <button
                            type="button"
                            onClick={() => setExpandAll((e) => !e)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-background hover:bg-muted text-xs"
                        >
                            {expandAll ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            {expandAll ? "Collapse" : "Expand All"}
                        </button>
                    )}
                </div>
            </div>
            <div className="flex-1 overflow-auto font-mono text-xs">
                {headerLines.map((line, idx) => (
                    <div key={`h-${idx}`} className="flex bg-muted/50 border-b border-border">
                        <span className="w-5 shrink-0" />
                        <pre className="flex-1 whitespace-pre-wrap px-2 py-0.5 text-muted-foreground italic text-[10px]">
                            {line.content}
                        </pre>
                    </div>
                ))}
                {useHunks
                    ? hunks.map((hunk, hi) => (
                        <div key={hi} className="border-b border-border/50">
                            {hunk.map((line, idx) => (
                                <DiffLineRow key={`${hi}-${idx}`} line={line} />
                            ))}
                        </div>
                    ))
                    : nonHeaderLines.map((line, idx) => <DiffLineRow key={idx} line={line} />)}
            </div>
        </div>
    );
}
