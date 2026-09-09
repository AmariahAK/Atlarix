/**
 * CodePreviewPanel
 * ================
 * Right panel host for the workspace Errors tab (runtime/build errors captured
 * from the browser tabs) and the Permissions tab. (The former live-preview tab
 * was removed — the agent runs the app in a Browser tab like any other URL.)
 */

import { useState } from "react";
import { useSetAtom, useAtomValue } from "jotai";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Trash2,
  Shield,
  Sparkles,
  Lightbulb,
  Check,
  Folder,
} from "lucide-react";
import { InlinePermissionsHint } from "@/components/chat/InlinePermissionsHint";
import { FixAllErrorsDialog } from "../FixAllErrorsDialog";
import {
  type TerminalOutput,
  browserErrorsAtom,
  dismissedErrorSignaturesAtom,
  visibleBrowserErrorsAtom,
  getErrorSignature,
} from "@/atoms/sourceAtoms";
import { type ParsedError } from "@/lib/devServerErrorParser";
import { TerminalPanel } from "@/components/panels/TerminalPanel";
import { PageConsole } from "./PageConsole";

interface CodePreviewPanelProps {
  data: {
    url?: string;
    terminal?: { output: string[]; running: boolean };
    terminalOutputs?: Map<string, TerminalOutput>;
    errors?: ParsedError[];
    chatId?: number; // For permissions tab
    workspacePath?: string;
    appId?: number | null;
  } | null;
  activeTab: string;
  onClearErrors?: () => void;
  onSolveWithAI?: (error: {
    message: string;
    source?: string;
    stack?: string;
  }) => void;
  onSolveAllWithAI?: (errors: ParsedError[], context: string) => void;
}

function CodePreviewPanel({
  data,
  activeTab,
  onClearErrors,
  onSolveWithAI,
  onSolveAllWithAI,
}: CodePreviewPanelProps) {
  const setBrowserErrors = useSetAtom(browserErrorsAtom);
  const setDismissedSignatures = useSetAtom(dismissedErrorSignaturesAtom);
  const visibleErrors = useAtomValue(visibleBrowserErrorsAtom);
  const errorsData =
    data?.errors !== undefined ? visibleErrors : data?.errors || [];

  return (
    <div className="flex flex-col h-full">
      {activeTab === "terminal" && <TerminalPanel />}
      {activeTab === "errors" && (
        /*
         * The Console tab holds two streams with genuinely different shapes:
         * dev-server/build errors (a set of problems, grouped by file, with
         * Fix All) and the page's own console (a chronological event stream).
         * Build errors only take space when there are some — otherwise the
         * console gets the whole panel.
         */
        <div className="flex flex-col h-full min-h-0 bg-[#1e1e1e]">
          {errorsData.length > 0 && (
            <div className="flex flex-col min-h-0 max-h-[45%] border-b border-zinc-800">
              <ErrorsTab
                errors={errorsData}
                onClear={onClearErrors}
                onSolveWithAI={onSolveWithAI}
                onSolveAllWithAI={onSolveAllWithAI}
                onMarkDone={(error) => {
                  setDismissedSignatures((prev) =>
                    new Set(prev).add(getErrorSignature(error)),
                  );
                  setBrowserErrors((prev) =>
                    prev.filter((e) => e.id !== error.id),
                  );
                }}
              />
            </div>
          )}
          <PageConsole />
        </div>
      )}
      {activeTab === "permissions" && <PermissionsTab />}
    </div>
  );
}

/**
 * Errors Tab - Enhanced IDE-style error display
 */
function ErrorsTab({
  errors,
  onClear,
  onSolveWithAI,
  onSolveAllWithAI,
  onMarkDone,
}: {
  errors: ParsedError[];
  onClear?: () => void;
  onSolveWithAI?: (error: ParsedError) => void;
  onSolveAllWithAI?: (errors: ParsedError[], context: string) => void;
  onMarkDone?: (error: ParsedError) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showFixAllDialog, setShowFixAllDialog] = useState(false);
  // State for "Suggest" feature - tracks which error has input open and the notes content
  const [suggestingErrorId, setSuggestingErrorId] = useState<string | null>(
    null,
  );
  const [suggestNotes, setSuggestNotes] = useState("");

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (errors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 bg-[#1e1e1e] gap-3">
        <Shield className="w-12 h-12 opacity-20 text-green-500" />
        <p className="text-sm text-green-500/80">No errors detected</p>
        <p className="text-xs text-zinc-500 text-center max-w-xs">
          Runtime and build errors from the dev server will appear here.
        </p>
      </div>
    );
  }

  // Deduplicate errors by message (normalized) to prevent multiple buttons for same error
  const deduplicatedErrors = errors.reduce(
    (acc, error) => {
      const normalizedMsg = error.message
        .replace(/:\d+:\d+/g, "") // Remove line:col
        .replace(/\?t=\d+/g, "") // Remove cache-busting
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);
      const key = `${normalizedMsg}-${error.file || ""}-${error.type}`;
      if (!acc.seen.has(key)) {
        acc.seen.add(key);
        acc.errors.push(error);
      }
      return acc;
    },
    { seen: new Set<string>(), errors: [] as ParsedError[] },
  ).errors;

  // Group errors by file
  const errorsByFile = deduplicatedErrors.reduce(
    (acc, error) => {
      const file = error.file || "General";
      if (!acc[file]) acc[file] = [];
      acc[file].push(error);
      return acc;
    },
    {} as Record<string, ParsedError[]>,
  );

  // Sort files locally (General last)
  const sortedFiles = Object.keys(errorsByFile).sort((a, b) => {
    if (a === "General") return 1;
    if (b === "General") return -1;
    return a.localeCompare(b);
  });

  const errorCount = deduplicatedErrors.filter(
    (e) => e.severity === "error",
  ).length;
  const warningCount = deduplicatedErrors.filter(
    (e) => e.severity === "warning",
  ).length;

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e]">
      {/* Errors Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-[#1e1e1e]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center justify-center w-5 h-5 rounded-full bg-red-500/20 text-red-400">
              <span className="text-xs font-bold">{errorCount}</span>
            </div>
            <span className="text-xs text-zinc-400">errors</span>
          </div>
          {warningCount > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="flex items-center justify-center w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-400">
                <span className="text-xs font-bold">{warningCount}</span>
              </div>
              <span className="text-xs text-zinc-400">warnings</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Fix All Button */}
          {errors.length > 1 && onSolveAllWithAI && (
            <button
              onClick={() => setShowFixAllDialog(true)}
              className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors"
              title="Fix all errors with AI"
            >
              <Sparkles className="w-3 h-3" />
              <span>Fix All</span>
            </button>
          )}
          {onClear && (
            <button
              onClick={onClear}
              className="p-1.5 text-xs rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Clear all errors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Error List */}
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {sortedFiles.map((file) => (
          <div key={file} className="space-y-1">
            {/* File Header */}
            {file !== "General" && (
              <div className="flex items-center gap-2 px-1 pb-1">
                <span className="text-xs font-medium text-zinc-400 font-mono">
                  {file}
                </span>
                <span className="h-px flex-1 bg-zinc-800"></span>
              </div>
            )}

            {/* Errors for this file */}
            <div className="space-y-2">
              {errorsByFile[file].map((error) => {
                const isExpanded = expandedIds.has(error.id);

                return (
                  <div
                    key={error.id}
                    className={cn(
                      "group rounded border transition-all duration-200",
                      error.severity === "error"
                        ? "bg-red-500/5 border-red-500/20 hover:border-red-500/40"
                        : "bg-yellow-500/5 border-yellow-500/20 hover:border-yellow-500/40",
                    )}
                  >
                    <div
                      className="p-3 cursor-pointer"
                      onClick={() => toggleExpanded(error.id)}
                    >
                      {error.file && (
                        <p className="flex items-center gap-1.5 text-xs text-zinc-500 mt-1 truncate">
                          <Folder className="w-3 h-3 shrink-0" />
                          <span className="truncate">
                            {error.file}
                            {error.line ? `:${error.line}` : ""}
                          </span>
                        </p>
                      )}
                      <div className="flex items-start gap-3">
                        {/* Icon */}
                        <AlertTriangle
                          className={cn(
                            "w-4 h-4 mt-0.5 flex-shrink-0",
                            error.severity === "error"
                              ? "text-red-400"
                              : "text-yellow-400",
                          )}
                        />

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={cn(
                                "text-xs px-1.5 py-0.5 rounded border uppercase font-bold tracking-wider",
                                error.severity === "error"
                                  ? "border-red-500/30 text-red-400 bg-red-500/10"
                                  : "border-yellow-500/30 text-yellow-400 bg-yellow-500/10",
                              )}
                            >
                              {error.type}
                            </span>
                            <span className="text-[10px] text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700">
                              {error.framework}
                            </span>
                          </div>

                          <p className="text-sm text-zinc-300 font-mono break-words leading-relaxed">
                            {error.message}
                          </p>

                          {/* Location */}
                          {(error.line || error.file) && (
                            <div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-500">
                              <span>
                                Line {error.line || "?"}:{error.column || "?"}
                              </span>
                            </div>
                          )}

                          {/* Suggestion */}
                          {error.suggestion && (
                            <div className="mt-2 flex items-start gap-1.5 text-xs text-emerald-400/80 bg-emerald-500/5 p-1.5 rounded border border-emerald-500/20">
                              <div className="w-1 h-1 rounded-full bg-emerald-500 mt-1.5"></div>
                              <span>Tip: {error.suggestion}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Action Bar (always visible if actionable) */}
                      {error.actionable && onSolveWithAI && (
                        <div className="mt-3 pl-7 space-y-2">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onSolveWithAI(error);
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors"
                            >
                              <Sparkles className="w-3 h-3" />
                              <span>Fix with AI</span>
                            </button>
                            {/* Mark done - remove from list */}
                            {onMarkDone && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onMarkDone(error);
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-700/30 text-zinc-300 hover:bg-zinc-700/50 border border-zinc-700/50 transition-colors"
                                title="Mark as done and remove from list"
                              >
                                <Check className="w-3 h-3" />
                                <span>Mark done</span>
                              </button>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (suggestingErrorId === error.id) {
                                  setSuggestingErrorId(null);
                                  setSuggestNotes("");
                                } else {
                                  setSuggestingErrorId(error.id);
                                  setSuggestNotes("");
                                }
                              }}
                              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                                suggestingErrorId === error.id
                                  ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                                  : "bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 border-zinc-700/50"
                              }`}
                            >
                              <Lightbulb className="w-3 h-3" />
                              <span>Suggest</span>
                            </button>
                          </div>

                          {/* Suggest Notes Input */}
                          {suggestingErrorId === error.id && (
                            <div
                              className="flex flex-col gap-2 p-2 rounded-md bg-zinc-800/50 border border-zinc-700/50"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="text"
                                value={suggestNotes}
                                onChange={(e) =>
                                  setSuggestNotes(e.target.value)
                                }
                                placeholder="Your suggestion for the AI (e.g., 'add export keyword')"
                                className="w-full px-2 py-1.5 text-xs rounded bg-zinc-900 border border-zinc-700 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-primary/50"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (
                                    e.key === "Enter" &&
                                    suggestNotes.trim()
                                  ) {
                                    // Create enhanced error with user's suggestion
                                    onSolveWithAI({
                                      ...error,
                                      message: `${error.message}\n\nUser's suggestion: ${suggestNotes}`,
                                    });
                                    setSuggestingErrorId(null);
                                    setSuggestNotes("");
                                  }
                                }}
                              />
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => {
                                    if (suggestNotes.trim()) {
                                      onSolveWithAI({
                                        ...error,
                                        message: `${error.message}\n\nUser's suggestion: ${suggestNotes}`,
                                      });
                                      setSuggestingErrorId(null);
                                      setSuggestNotes("");
                                    }
                                  }}
                                  disabled={!suggestNotes.trim()}
                                  className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                  <span>Send with Notes</span>
                                </button>
                                <button
                                  onClick={() => {
                                    setSuggestingErrorId(null);
                                    setSuggestNotes("");
                                  }}
                                  className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Raw Details (Expanded) */}
                    {isExpanded && error.rawOutput && (
                      <div className="border-t border-zinc-800 bg-black/20 p-3">
                        <pre className="text-[10px] text-zinc-500 font-mono whitespace-pre-wrap overflow-x-auto">
                          {error.rawOutput}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Fix All Errors Dialog */}
      {onSolveAllWithAI && (
        <FixAllErrorsDialog
          isOpen={showFixAllDialog}
          onClose={() => setShowFixAllDialog(false)}
          errors={errors}
          onSubmit={(selectedErrors, context) => {
            onSolveAllWithAI(selectedErrors, context);
            setShowFixAllDialog(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Permissions Tab - Show pending permission requests
 * Features empty state when no permissions pending
 */
function PermissionsTab() {
  return (
    <div className="flex flex-col h-full">
      <InlinePermissionsHint />
    </div>
  );
}

export default CodePreviewPanel;
