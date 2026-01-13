/**
 * ErrorFileEditor
 * ===============
 * Monaco-based code editor for files with errors.
 * Features:
 * - Collapsible file list (files with errors)
 * - Monaco editor with syntax highlighting
 * - Save with Cmd/Ctrl+S
 * - Unsaved changes indicator
 * - Error line highlighting
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Editor, { OnMount, Monaco } from '@monaco-editor/react';
import { IpcClient } from '@/ipc/ipc_client';
import { cn } from '@/lib/utils';
import {
    ChevronDown,
    ChevronRight,
    FileCode2,
    Save,
    AlertTriangle,
    AlertCircle,
    Check,
    Loader2,
} from 'lucide-react';
import { type ParsedError } from '@/lib/devServerErrorParser';

interface ErrorFileEditorProps {
    errors: ParsedError[];
    workspacePath: string;
    onErrorResolved?: (error: ParsedError) => void;
}

interface FileWithErrors {
    path: string;
    absolutePath: string;
    errors: ParsedError[];
}

export function ErrorFileEditor({ errors, workspacePath, onErrorResolved }: ErrorFileEditorProps) {
    const [filesExpanded, setFilesExpanded] = useState(true);
    const [selectedFile, setSelectedFile] = useState<FileWithErrors | null>(null);
    const [fileContent, setFileContent] = useState<string>('');
    const [originalContent, setOriginalContent] = useState<string>('');
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving'>('saved');
    // FIX 3 (v0.9.15): Track initial load vs user editing to prevent cursor jumping
    const [isInitialLoad, setIsInitialLoad] = useState(true);
    const editorRef = useRef<any>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const decorationIdsRef = useRef<string[]>([]);

    /**
     * Clean file path from URLs
     * Handles: http://localhost:5174/src/components/Foo.tsx -> src/components/Foo.tsx
     * Filters out external CDN URLs (jsdelivr, unpkg, etc.)
     */
    const cleanFilePath = useCallback((rawPath: string): string | null => {
        // Skip external CDN/library files
        if (rawPath.includes('cdn.jsdelivr.net') ||
            rawPath.includes('unpkg.com') ||
            rawPath.includes('node_modules') ||
            rawPath.includes('esm.sh')) {
            return null;
        }

        // Extract path from URL (http://localhost:5174/src/... -> src/...)
        if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
            try {
                const url = new URL(rawPath);
                // Get pathname and remove leading slash
                const pathname = url.pathname.replace(/^\//, '');
                // If empty or root, skip
                if (!pathname || pathname === '/') return null;
                return pathname;
            } catch {
                return null;
            }
        }

        // Already a relative or absolute path
        return rawPath;
    }, []);

    // Group errors by file
    const filesWithErrors = useMemo<FileWithErrors[]>(() => {
        const fileMap = new Map<string, ParsedError[]>();

        for (const error of errors) {
            if (error.file) {
                // Clean the file path (remove URL prefix, filter externals)
                const cleanPath = cleanFilePath(error.file);
                if (!cleanPath) continue; // Skip external/invalid files

                const existing = fileMap.get(cleanPath) || [];
                existing.push(error);
                fileMap.set(cleanPath, existing);
            }
        }

        return Array.from(fileMap.entries())
            .map(([path, fileErrors]) => ({
                path,
                absolutePath: path.startsWith('/') ? path : `${workspacePath}/${path}`,
                errors: fileErrors,
            }))
            .sort((a, b) => b.errors.length - a.errors.length); // Most errors first
    }, [errors, workspacePath, cleanFilePath]);

    // Auto-select first file if none selected
    useEffect(() => {
        if (!selectedFile && filesWithErrors.length > 0) {
            setSelectedFile(filesWithErrors[0]);
        }
    }, [filesWithErrors, selectedFile]);

    // Load file content when selected file changes
    useEffect(() => {
        if (!selectedFile) return;

        // FIX 3: Mark as initial load when file changes
        setIsInitialLoad(true);

        const loadFile = async () => {
            setIsLoading(true);
            try {
                const result = await IpcClient.getInstance().readFileContent(selectedFile.absolutePath);
                if (result.success && result.content !== undefined) {
                    setFileContent(result.content);
                    setOriginalContent(result.content);
                    setSaveStatus('saved');
                } else {
                    console.error('Failed to load file:', result.error);
                }
            } catch (error) {
                console.error('Failed to load file:', error);
            } finally {
                setIsLoading(false);
            }
        };

        loadFile();
    }, [selectedFile]);

    // Track unsaved changes
    useEffect(() => {
        if (fileContent !== originalContent) {
            setSaveStatus('unsaved');
        }
    }, [fileContent, originalContent]);

    // Save file
    const handleSave = useCallback(async () => {
        if (!selectedFile || saveStatus !== 'unsaved') return;

        setIsSaving(true);
        setSaveStatus('saving');

        try {
            const result = await IpcClient.getInstance().writeFileContent(
                selectedFile.absolutePath,
                fileContent
            );

            if (result.success) {
                setOriginalContent(fileContent);
                setSaveStatus('saved');
                // Brief success indication
                setTimeout(() => setSaveStatus('saved'), 1500);
            } else {
                console.error('Failed to save file:', result.error);
                setSaveStatus('unsaved');
            }
        } catch (error) {
            console.error('Failed to save file:', error);
            setSaveStatus('unsaved');
        } finally {
            setIsSaving(false);
        }
    }, [selectedFile, fileContent, saveStatus]);

    // Editor mounted callback
    const handleEditorMount: OnMount = useCallback((editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        // Disable Monaco's built-in TypeScript/JavaScript validation
        // This prevents "inmemory://model" errors since we don't have full type context
        monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: true,
        });
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: true,
        });

        // Add Cmd/Ctrl+S keybinding
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            handleSave();
        });
    }, [handleSave]);

    // Highlight error lines in editor with decorations AND markers (underlines)
    // FIX 3 (v0.9.15): Only apply on initial load to prevent cursor jumping during typing
    useEffect(() => {
        // Skip if not initial load (user is editing) - this prevents cursor jumping
        if (!editorRef.current || !monacoRef.current || !selectedFile || isLoading || !isInitialLoad) return;

        const editor = editorRef.current;
        const monaco = monacoRef.current;

        // Small delay to ensure model is fully ready after content loads
        const applyMarkers = () => {
            const model = editor.getModel();
            if (!model || model.isDisposed()) return;

            // Create decorations for error lines (background highlighting)
            // Line numbers must be positive integers for Monaco
            const validErrors = selectedFile.errors.filter(err =>
                typeof err.line === 'number' && err.line > 0 && Number.isInteger(err.line)
            );

            const decorations = validErrors.map(err => ({
                range: new monaco.Range(err.line!, 1, err.line!, 1),
                options: {
                    isWholeLine: true,
                    className: err.severity === 'error'
                        ? 'error-line-decoration'
                        : 'warning-line-decoration',
                    glyphMarginClassName: err.severity === 'error'
                        ? 'error-glyph-margin'
                        : 'warning-glyph-margin',
                    glyphMarginHoverMessage: { value: err.message },
                },
            }));

            // Properly dispose old decorations before adding new ones
            decorationIdsRef.current = editor.deltaDecorations(
                decorationIdsRef.current,
                decorations
            );

            // Create Monaco markers (squiggly underlines like IDE)
            const markers = validErrors.map(err => {
                const line = err.line!;
                const column = err.column || 1;
                // Get line content to calculate end column
                const lineContent = model.getLineContent(line) || '';
                const endColumn = column + 20; // Underline ~20 chars or to end of line

                return {
                    severity: err.severity === 'error'
                        ? monaco.MarkerSeverity.Error
                        : monaco.MarkerSeverity.Warning,
                    message: err.message,
                    startLineNumber: line,
                    startColumn: column,
                    endLineNumber: line,
                    endColumn: Math.min(endColumn, lineContent.length + 1),
                };
            });

            // Set markers on the model
            monaco.editor.setModelMarkers(model, 'error-file-editor', markers);

            // Jump to first error line - ONLY on initial load (not during typing)
            const firstError = validErrors[0];
            if (firstError && firstError.line && firstError.line > 0) {
                editor.revealLineInCenter(firstError.line);
                // Also position cursor at the error
                editor.setPosition({
                    lineNumber: firstError.line,
                    column: Math.max(1, firstError.column || 1)
                });
            }
        };

        // Apply immediately and also after a short delay to catch late model updates
        applyMarkers();
        const timerId = setTimeout(applyMarkers, 100);

        // Cleanup markers and decorations when component unmounts or file changes
        return () => {
            clearTimeout(timerId);
            // Clear decorations
            if (editorRef.current && decorationIdsRef.current.length > 0) {
                decorationIdsRef.current = editorRef.current.deltaDecorations(
                    decorationIdsRef.current,
                    []
                );
            }
            // Clear markers
            const model = editor.getModel();
            if (model && !model.isDisposed()) {
                monaco.editor.setModelMarkers(model, 'error-file-editor', []);
            }
        };
        // FIX 3: Remove fileContent from deps, use isInitialLoad instead
    }, [selectedFile, isLoading, isInitialLoad]);

    // Get file extension for language detection
    const getLanguage = (filePath: string): string => {
        const ext = filePath.split('.').pop()?.toLowerCase();
        const langMap: Record<string, string> = {
            ts: 'typescript',
            tsx: 'typescript',
            js: 'javascript',
            jsx: 'javascript',
            mjs: 'javascript',
            cjs: 'javascript',
            json: 'json',
            css: 'css',
            scss: 'scss',
            less: 'less',
            html: 'html',
            vue: 'vue',
            svelte: 'html',
            md: 'markdown',
            py: 'python',
            rs: 'rust',
            go: 'go',
        };
        return langMap[ext || ''] || 'plaintext';
    };

    if (filesWithErrors.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6">
                <Check className="w-12 h-12 mb-3 text-green-500/50" />
                <p className="text-sm text-green-500/80">No files with errors</p>
                <p className="text-xs text-muted-foreground/60">All errors have been resolved</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e]">
            {/* Collapsible File List */}
            <div className="border-b border-zinc-800">
                <button
                    onClick={() => setFilesExpanded(!filesExpanded)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-800/50 transition-colors"
                >
                    {filesExpanded ? (
                        <ChevronDown className="w-4 h-4 text-zinc-500" />
                    ) : (
                        <ChevronRight className="w-4 h-4 text-zinc-500" />
                    )}
                    <span className="text-zinc-300 font-medium">Files with Errors</span>
                    <span className="ml-auto text-xs text-zinc-500">
                        {filesWithErrors.length} file{filesWithErrors.length !== 1 ? 's' : ''}
                    </span>
                </button>

                {filesExpanded && (
                    <div className="max-h-32 overflow-y-auto">
                        {filesWithErrors.map(file => (
                            <button
                                key={file.path}
                                onClick={() => setSelectedFile(file)}
                                className={cn(
                                    "w-full flex items-center gap-2 px-4 py-1.5 text-xs hover:bg-zinc-800/50 transition-colors",
                                    selectedFile?.path === file.path && "bg-zinc-800"
                                )}
                            >
                                <FileCode2 className="w-3.5 h-3.5 text-zinc-500" />
                                <span className="text-zinc-300 truncate flex-1 text-left">
                                    {file.path.split('/').pop()}
                                </span>
                                <span className={cn(
                                    "px-1.5 py-0.5 rounded text-[10px] font-medium",
                                    file.errors.some(e => e.severity === 'error')
                                        ? "bg-red-500/20 text-red-400"
                                        : "bg-yellow-500/20 text-yellow-400"
                                )}>
                                    {file.errors.length}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Editor Header */}
            {selectedFile && (
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/50">
                    <div className="flex items-center gap-2 min-w-0">
                        <FileCode2 className="w-4 h-4 text-zinc-500 shrink-0" />
                        <span className="text-xs text-zinc-300 truncate" title={selectedFile.path}>
                            {selectedFile.path}
                        </span>
                        {saveStatus === 'unsaved' && (
                            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                        )}
                    </div>
                    <button
                        onClick={handleSave}
                        disabled={saveStatus !== 'unsaved' || isSaving}
                        className={cn(
                            "flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors",
                            saveStatus === 'unsaved'
                                ? "bg-primary/10 text-primary hover:bg-primary/20"
                                : "text-zinc-500 cursor-not-allowed"
                        )}
                    >
                        {isSaving ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                            <Save className="w-3 h-3" />
                        )}
                        <span className="hidden sm:inline">
                            {isSaving ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : 'Save'}
                        </span>
                        <kbd className="hidden sm:inline text-[10px] text-zinc-500 ml-1">⌘S</kbd>
                    </button>
                </div>
            )}

            {/* Monaco Editor */}
            <div className="flex-1 min-h-0">
                {isLoading ? (
                    <div className="flex items-center justify-center h-full">
                        <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
                    </div>
                ) : selectedFile ? (
                    <Editor
                        key={selectedFile.absolutePath}
                        path={selectedFile.absolutePath}
                        height="100%"
                        language={getLanguage(selectedFile.path)}
                        value={fileContent}
                        onChange={(value) => {
                            // FIX 3: Mark as no longer initial load when user starts typing
                            setIsInitialLoad(false);
                            setFileContent(value || '');
                        }}
                        onMount={handleEditorMount}
                        theme="vs-dark"
                        options={{
                            fontSize: 12,
                            fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            lineNumbers: 'on',
                            glyphMargin: true,
                            folding: true,
                            automaticLayout: true,
                            tabSize: 2,
                            wordWrap: 'on',
                            quickSuggestions: false,
                            parameterHints: { enabled: false },
                            suggestOnTriggerCharacters: false,
                            acceptSuggestionOnCommitCharacter: false,
                            tabCompletion: 'off',
                        }}
                    />
                ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                        <p className="text-sm">Select a file to edit</p>
                    </div>
                )}
            </div>

            {/* Error Summary Footer */}
            {selectedFile && (
                <div className="flex items-center gap-4 px-3 py-1.5 border-t border-zinc-800 bg-zinc-900/50 text-xs">
                    {selectedFile.errors.filter(e => e.severity === 'error').length > 0 && (
                        <div className="flex items-center gap-1 text-red-400">
                            <AlertCircle className="w-3 h-3" />
                            <span>{selectedFile.errors.filter(e => e.severity === 'error').length} errors</span>
                        </div>
                    )}
                    {selectedFile.errors.filter(e => e.severity === 'warning').length > 0 && (
                        <div className="flex items-center gap-1 text-yellow-400">
                            <AlertTriangle className="w-3 h-3" />
                            <span>{selectedFile.errors.filter(e => e.severity === 'warning').length} warnings</span>
                        </div>
                    )}
                </div>
            )}

            {/* CSS for error decorations */}
            <style>{`
                .error-line-decoration {
                    background-color: rgba(239, 68, 68, 0.15) !important;
                }
                .warning-line-decoration {
                    background-color: rgba(234, 179, 8, 0.15) !important;
                }
                .error-glyph-margin {
                    background: rgb(239, 68, 68) !important;
                    width: 8px !important;
                    height: 8px !important;
                    border-radius: 50% !important;
                    margin-left: 4px !important;
                    margin-top: 6px !important;
                }
                .warning-glyph-margin {
                    background: rgb(234, 179, 8) !important;
                    width: 8px !important;
                    height: 8px !important;
                    border-radius: 50% !important;
                    margin-left: 4px !important;
                    margin-top: 6px !important;
                }
            `}</style>
        </div>
    );
}
