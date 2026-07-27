/**
 * SmartDiffView
 * =============
 * Compact diff display with:
 * - Real LCS hunks (diff package) with ±3 lines of context — multiple change
 *   regions render as separate hunks (v10)
 * - Optional per-hunk accept/reject checkboxes (v10 — inline approvals)
 * - Expand All button for full view
 * - AI-generated summary at top
 */

import { useState, useMemo, useEffect } from "react";
import { cn } from "@/lib/utils";
import { FileEdit, ChevronDown, ChevronUp } from "lucide-react";
import { computeDiffHunks, type DiffHunk } from "@/lib/diff/compose-hunks";
import { Checkbox } from "@/components/ui/checkbox";

const CONTEXT_LINES = 3;
const EXPAND_ALL_CONTEXT = 100000;

/**
 * Rendered rows past which a COMPLETED diff card starts collapsed.
 *
 * Every row is a flex div with five children, so a 1000-line generated file is
 * ~5000 nodes laid out for a card nobody reads line-by-line. Collapsed, the card
 * shows its counts — which main already computed — and mounts nothing.
 *
 * Approval diffs are exempt (see `canCollapse`): hiding a change behind a click
 * at the moment you're being asked to approve it is worse than the cost.
 */
const COLLAPSE_ROW_THRESHOLD = 200;

type DiffLineType = {
    type: "context" | "add" | "remove";
    content: string;
    oldLineNum?: number;
    newLineNum?: number;
};

function DiffLineRow({ line, dimmed }: { line: DiffLineType; dimmed?: boolean }) {
    return (
        <div
            className={cn("flex", dimmed && "opacity-40")}
            style={{
                backgroundColor: line.type === "add" ? "var(--diff-add-bg)" : line.type === "remove" ? "var(--diff-remove-bg)" : undefined,
            }}
        >
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

/** create/delete render as one synthetic full-file hunk (no per-hunk selection). */
function wholeFileHunk(content: string, type: "add" | "remove"): DiffHunk {
    const lines = content.split("\n");
    return {
        index: 0,
        oldStart: 1,
        oldLines: type === "remove" ? lines.length : 0,
        newStart: 1,
        newLines: type === "add" ? lines.length : 0,
        addedCount: type === "add" ? lines.length : 0,
        removedCount: type === "remove" ? lines.length : 0,
        lines: lines.map((l, i) => ({
            type,
            content: l,
            ...(type === "add" ? { newLineNum: i + 1 } : { oldLineNum: i + 1 }),
        })),
    };
}

export interface SmartDiffViewProps {
    path: string;
    oldContent: string;
    newContent: string;
    description?: string;
    operation?: "create" | "update" | "delete";
    maxHeight?: string;
    /**
     * v10: per-hunk accept/reject. When true, each hunk gets a checkbox
     * (default checked). `onHunkSelectionChange` fires with the selected hunk
     * indices + total so the approval flow can compose partial content.
     */
    selectable?: boolean;
    onHunkSelectionChange?: (selected: number[], totalHunks: number) => void;
    /**
     * Hunks computed in MAIN, where both file bodies already are.
     *
     * `computeDiffHunks` runs `structuredPatch` — a Myers diff over the whole
     * file — and it used to run here, synchronously inside a `useMemo`, on the
     * UI thread. A ~1000-line write froze the app for about five seconds, and
     * it scales worse than linearly. Main holds `oldContent` and `newContent`
     * when it sends the preview, so it can do this once, off the UI thread,
     * and hand over the result.
     *
     * Optional: paths that don't supply it (other approval surfaces, tests)
     * fall back to computing locally, so behaviour is unchanged where it isn't
     * wired up.
     */
    precomputedHunks?: DiffHunk[];
}

export function SmartDiffView({
    path,
    oldContent,
    newContent,
    description,
    operation = "update",
    maxHeight = "max-h-64",
    selectable = false,
    onHunkSelectionChange,
    precomputedHunks,
}: SmartDiffViewProps) {
    const [expandAll, setExpandAll] = useState(false);
    const [deselected, setDeselected] = useState<Set<number>>(new Set());
    /** null = follow the size heuristic; true/false = the user decided. */
    const [bodyOpenOverride, setBodyOpenOverride] = useState<boolean | null>(null);

    // Hunk geometry depends on context size — reset selection when it changes.
    useEffect(() => {
        setDeselected(new Set());
    }, [expandAll]);

    const hunks: DiffHunk[] = useMemo(() => {
        if (operation === "create") return [wholeFileHunk(newContent, "add")];
        if (operation === "delete") return [wholeFileHunk(oldContent, "remove")];
        // Precomputed hunks cover the DEFAULT context only. Expanding asks for a
        // different diff, and it is a deliberate user action on a diff they chose
        // to read — so paying for it then is fine, where paying on every render
        // was not.
        if (precomputedHunks && !expandAll) return precomputedHunks;
        return computeDiffHunks(
            oldContent,
            newContent,
            expandAll ? EXPAND_ALL_CONTEXT : CONTEXT_LINES,
        );
    }, [oldContent, newContent, operation, expandAll, precomputedHunks]);

    // Selection applies only to update diffs with at least 2 hunks.
    const hunkSelectable = selectable && operation === "update" && hunks.length > 1;

    useEffect(() => {
        if (!onHunkSelectionChange) return;
        if (!hunkSelectable) {
            // Selection UI off (single hunk / expand-all) → everything applies.
            onHunkSelectionChange(hunks.map((h) => h.index), hunks.length);
            return;
        }
        const selected = hunks
            .map((h) => h.index)
            .filter((i) => !deselected.has(i));
        onHunkSelectionChange(selected, hunks.length);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deselected, hunks.length, hunkSelectable]);

    const toggleHunk = (index: number) => {
        setDeselected((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const addedCount = hunks.reduce((acc, h) => acc + h.addedCount, 0);
    const removedCount = hunks.reduce((acc, h) => acc + h.removedCount, 0);
    const totalLines = hunks.reduce((acc, h) => acc + h.lines.length, 0);

    // Never auto-collapse something the user is being asked to approve, or a
    // diff with per-hunk checkboxes they need to see to use.
    const canCollapse = !selectable && totalLines > COLLAPSE_ROW_THRESHOLD;
    const bodyOpen = bodyOpenOverride ?? !canCollapse;
    const headerLabel =
        operation === "create"
            ? `+++ ${path} (new file)`
            : operation === "delete"
              ? `--- ${path} (deleted)`
              : `--- ${path}  →  +++ ${path}`;

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
                    {hunkSelectable ? (
                        <span className="text-[10px] text-muted-foreground shrink-0">
                            {hunks.length - deselected.size}/{hunks.length} hunks selected
                        </span>
                    ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0 text-[10px]">
                    {addedCount > 0 && <span style={{ color: "var(--diff-add-text)" }}>+{addedCount}</span>}
                    {removedCount > 0 && <span style={{ color: "var(--diff-remove-text)" }}>-{removedCount}</span>}
                    {canCollapse && (
                        <button
                            type="button"
                            onClick={() => setBodyOpenOverride(!bodyOpen)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-background hover:bg-muted text-xs"
                        >
                            {bodyOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            {bodyOpen ? "Hide diff" : `Show diff · ${hunks.length} hunk${hunks.length === 1 ? "" : "s"}`}
                        </button>
                    )}
                    {bodyOpen && operation === "update" && totalLines > 20 && (
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
            {!bodyOpen ? (
                // Collapsed: the counts above already say what changed, and they
                // came from main — so this mounts no rows at all.
                <div className="px-3 py-2 text-xs text-muted-foreground">
                    {totalLines.toLocaleString()} lines across {hunks.length} hunk
                    {hunks.length === 1 ? "" : "s"} — hidden to keep the chat responsive.
                </div>
            ) : (
            <div className="flex-1 overflow-auto font-mono text-xs">
                <div className="flex bg-muted/50 border-b border-border">
                    <span className="w-5 shrink-0" />
                    <pre className="flex-1 whitespace-pre-wrap px-2 py-0.5 text-muted-foreground italic text-[10px]">
                        {headerLabel}
                    </pre>
                </div>
                {hunks.map((hunk) => {
                    const isDeselected = hunkSelectable && deselected.has(hunk.index);
                    return (
                        <div key={hunk.index} className="border-b border-border/50">
                            {(hunkSelectable || hunks.length > 1) && !expandAll ? (
                                <div
                                    className={cn(
                                        "flex items-center gap-2 px-2 py-1 bg-muted/40 border-b border-border/40",
                                        hunkSelectable && "cursor-pointer hover:bg-muted/60",
                                    )}
                                    onClick={hunkSelectable ? () => toggleHunk(hunk.index) : undefined}
                                    role={hunkSelectable ? "button" : undefined}
                                >
                                    {hunkSelectable ? (
                                        <Checkbox
                                            checked={!isDeselected}
                                            onCheckedChange={() => toggleHunk(hunk.index)}
                                            onClick={(e) => e.stopPropagation()}
                                            className="h-3.5 w-3.5"
                                            aria-label={`Include hunk ${hunk.index + 1}`}
                                        />
                                    ) : null}
                                    <span className="text-[10px] text-muted-foreground italic select-none">
                                        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                                    </span>
                                    <span className="text-[10px] tabular-nums select-none">
                                        {hunk.addedCount > 0 && <span style={{ color: "var(--diff-add-text)" }}>+{hunk.addedCount}</span>}{" "}
                                        {hunk.removedCount > 0 && <span style={{ color: "var(--diff-remove-text)" }}>-{hunk.removedCount}</span>}
                                    </span>
                                    {isDeselected ? (
                                        <span className="text-[10px] text-muted-foreground/80 select-none ml-auto">
                                            skipped — file keeps the original lines
                                        </span>
                                    ) : null}
                                </div>
                            ) : null}
                            {hunk.lines.map((line, idx) => (
                                <DiffLineRow key={`${hunk.index}-${idx}`} line={line} dimmed={isDeselected} />
                            ))}
                        </div>
                    );
                })}
                {hunks.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-muted-foreground italic">
                        No line changes detected.
                    </div>
                ) : null}
            </div>
            )}
        </div>
    );
}
