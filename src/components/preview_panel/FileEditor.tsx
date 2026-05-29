import React, { useState, useRef, useEffect, useCallback } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useLoadAppFile } from "@/hooks/useLoadAppFile";
import { useTheme } from "@/contexts/ThemeContext";
import { ChevronRight, Circle, Save } from "lucide-react";
import "@/components/chat/monaco";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showSuccess, showWarning } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings } from "@/hooks/useSettings";
import { getLanguage } from "@/utils/get_language";
import {
  applyLspMarkersToModel,
  type LspDiagnosticPayload,
} from "@/lib/lsp/lsp-monaco-markers";

interface FileEditorProps {
  appId: number | null;
  filePath: string;
  /** When set (e.g. from Errors "View code"), scroll to this line after load */
  initialLine?: number;
}

interface BreadcrumbProps {
  path: string;
  hasUnsavedChanges: boolean;
  onSave: () => void;
  isSaving: boolean;
}

const Breadcrumb: React.FC<BreadcrumbProps> = ({
  path,
  hasUnsavedChanges,
  onSave,
  isSaving,
}) => {
  const segments = path.split("/").filter(Boolean);

  return (
    <div className="flex items-center justify-between px-4 py-2 text-sm text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-1 overflow-hidden">
        <div className="flex items-center gap-1 overflow-hidden min-w-0">
          {segments.map((segment, index) => (
            <React.Fragment key={index}>
              {index > 0 && (
                <ChevronRight
                  size={14}
                  className="text-gray-400 flex-shrink-0"
                />
              )}
              <span className="hover:text-gray-900 dark:hover:text-gray-100 cursor-pointer truncate">
                {segment}
              </span>
            </React.Fragment>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSave}
                disabled={!hasUnsavedChanges || isSaving}
                className="h-6 w-6 p-0"
                data-testid="save-file-button"
              >
                <Save size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {hasUnsavedChanges ? "Save changes" : "No unsaved changes"}
            </TooltipContent>
          </Tooltip>
          {hasUnsavedChanges && (
            <Circle
              size={8}
              fill="currentColor"
              className="text-amber-600 dark:text-amber-400"
            />
          )}
        </div>
      </div>
    </div>
  );
};

export const FileEditor = ({ appId, filePath, initialLine }: FileEditorProps) => {
  const { content, loading, error } = useLoadAppFile(appId, filePath);
  const { theme } = useTheme();
  const [value, setValue] = useState<string | undefined>(undefined);
  const [displayUnsavedChanges, setDisplayUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [plainTextMode, setPlainTextMode] = useState(false);
  const [editorLanguage, setEditorLanguage] = useState(() => getLanguage(filePath));
  const { settings } = useSettings();
  // Use refs for values that need to be current in event handlers
  const originalValueRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const needsSaveRef = useRef<boolean>(false);
  const currentValueRef = useRef<string | undefined>(undefined);
  const absFilePathRef = useRef<string | null>(null);
  const lspChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lspDocVersionRef = useRef(0);

  const queryClient = useQueryClient();

  const applyDiagnostics = useCallback((diagnostics: LspDiagnosticPayload[]) => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    applyLspMarkersToModel(model, diagnostics);
  }, []);

  useEffect(() => {
    if (!appId || content === null) return;

    const ipc = IpcClient.getInstance();
    let cancelled = false;

    void (async () => {
      await ipc.lspSubscribe(appId);
      if (cancelled || content === null) return;
      const opened = await ipc.lspOpenDocument({
        appId,
        filePath,
        content,
      });
      if (!cancelled && opened.success && opened.filePath) {
        absFilePathRef.current = opened.filePath;
      }
    })();

    const removeListener = ipc.onLspDiagnostics((payload) => {
      if (
        absFilePathRef.current &&
        payload.filePath !== absFilePathRef.current
      ) {
        return;
      }
      applyDiagnostics(payload.diagnostics);
    });

    return () => {
      cancelled = true;
      removeListener();
      if (lspChangeTimerRef.current) {
        clearTimeout(lspChangeTimerRef.current);
      }
      void ipc.lspClose({ appId, filePath });
      void ipc.lspUnsubscribe();
      absFilePathRef.current = null;
      const model = editorRef.current?.getModel();
      if (model) {
        applyLspMarkersToModel(model, []);
      }
    };
  }, [appId, filePath, content, applyDiagnostics]);

  // Update state when content loads
  useEffect(() => {
    if (content !== null) {
      setValue(content);
      originalValueRef.current = content;
      currentValueRef.current = content;
      needsSaveRef.current = false;
      setDisplayUnsavedChanges(false);
      setIsSaving(false);
    }
  }, [content, filePath]);

  useEffect(() => {
    setEditorLanguage(getLanguage(filePath));
    setPlainTextMode(false);
  }, [filePath]);

  useEffect(() => {
    const onTokenizerError = (event: ErrorEvent) => {
      const msg = event.message ?? "";
      if (
        msg.includes("look-behind") ||
        msg.includes("OnigScanner") ||
        msg.includes("invalid pattern")
      ) {
        event.preventDefault();
        setPlainTextMode(true);
        setEditorLanguage("plaintext");
      }
    };
    window.addEventListener("error", onTokenizerError);
    return () => window.removeEventListener("error", onTokenizerError);
  }, [filePath]);

  // Sync the UI with the needsSave ref
  useEffect(() => {
    setDisplayUnsavedChanges(needsSaveRef.current);
  }, [needsSaveRef.current]);

  // Determine if dark mode based on theme
  const isDarkMode =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const editorTheme = isDarkMode ? "atlarix-dark" : "atlarix-light";

  // Handle editor mount
  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
    if (typeof initialLine === "number" && initialLine >= 1) {
      editor.revealLineInCenter(initialLine, 1);
    }

    // Listen for model content change events
    editor.onDidBlurEditorText(() => {
      console.log("Editor text blurred, checking if save needed");
      if (needsSaveRef.current) {
        saveFile();
      }
    });
  };

  // Handle content change
  const handleEditorChange = (newValue: string | undefined) => {
    setValue(newValue);
    currentValueRef.current = newValue;

    const hasChanged = newValue !== originalValueRef.current;
    needsSaveRef.current = hasChanged;
    setDisplayUnsavedChanges(hasChanged);

    if (!appId || newValue === undefined) return;
    if (lspChangeTimerRef.current) {
      clearTimeout(lspChangeTimerRef.current);
    }
    lspChangeTimerRef.current = setTimeout(() => {
      lspDocVersionRef.current += 1;
      void IpcClient.getInstance().lspChange({
        appId,
        filePath,
        content: newValue,
        version: lspDocVersionRef.current,
      });
    }, 300);
  };

  // Save the file
  const saveFile = async () => {
    if (
      !appId ||
      !currentValueRef.current ||
      !needsSaveRef.current ||
      isSavingRef.current
    )
      return;

    try {
      isSavingRef.current = true;
      setIsSaving(true);

      const ipcClient = IpcClient.getInstance();
      const { warning } = await ipcClient.editAppFile(
        appId,
        filePath,
        currentValueRef.current,
      );
      await queryClient.invalidateQueries({ queryKey: ["versions", appId] });
      if (warning) {
        showWarning(warning);
      } else {
        showSuccess("File saved");
      }

      originalValueRef.current = currentValueRef.current;
      needsSaveRef.current = false;
      setDisplayUnsavedChanges(false);
    } catch (error) {
      showError(error);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  if (loading) {
    return <div className="p-4">Loading file content...</div>;
  }

  if (error) {
    return <div className="p-4 text-red-500">Error: {error.message}</div>;
  }

  if (!content) {
    return <div className="p-4 text-gray-500">No content available</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <Breadcrumb
        path={filePath}
        hasUnsavedChanges={displayUnsavedChanges}
        onSave={saveFile}
        isSaving={isSaving}
      />
      <div className="flex-1 overflow-hidden">
        {plainTextMode ? (
          <div className="px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 border-b border-border/40 bg-muted/20">
            Syntax highlighting unavailable — showing plain text.
          </div>
        ) : null}
        <Editor
          height="100%"
          language={plainTextMode ? "plaintext" : editorLanguage}
          value={value}
          theme={editorTheme}
          onChange={handleEditorChange}
          onMount={handleEditorDidMount}
          options={{
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            fontFamily: "monospace",
            fontSize: 13,
            lineNumbers: "on",
            lineNumbersMinChars: 3,
            glyphMargin: false,
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
    </div>
  );
};
