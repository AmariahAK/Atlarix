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
import { getLanguage } from "@/utils/get_language";
import {
  ensureTextMateReady,
  isTextMateGrammarsReady,
  languageUsesTextMate,
} from "@/lib/monaco/init-textmate";
import * as monaco from "monaco-editor";
import { applyPreviewMarkersToModel } from "@/lib/monaco/preview-error-markers";
import type { ParsedError } from "@/lib/devServerErrorParser";

interface FileEditorProps {
  appId: number | null;
  filePath: string;
  /** When set (e.g. from Errors "View code"), scroll to this line after load */
  initialLine?: number;
  /** Preview / runtime errors for this workspace — shown as squiggles on matching lines */
  previewErrors?: ParsedError[];
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

export const FileEditor = ({
  appId,
  filePath,
  initialLine,
  previewErrors = [],
}: FileEditorProps) => {
  const { content, loading, error } = useLoadAppFile(appId, filePath);
  const { theme } = useTheme();
  const [value, setValue] = useState<string | undefined>(undefined);
  const [displayUnsavedChanges, setDisplayUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editorLanguage, setEditorLanguage] = useState(() => getLanguage(filePath));
  const needsTextMate = languageUsesTextMate(editorLanguage);
  const [textMateReady, setTextMateReady] = useState(
    () => !needsTextMate || isTextMateGrammarsReady(),
  );
  // Use refs for values that need to be current in event handlers
  const originalValueRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const needsSaveRef = useRef<boolean>(false);
  const currentValueRef = useRef<string | undefined>(undefined);
  const queryClient = useQueryClient();

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
  }, [filePath]);

  useEffect(() => {
    const lang = getLanguage(filePath);
    const needsTm = languageUsesTextMate(lang);
    if (!needsTm) {
      setTextMateReady(true);
      return;
    }
    if (isTextMateGrammarsReady()) {
      setTextMateReady(true);
      return;
    }
    setTextMateReady(false);
    void ensureTextMateReady().then(() => setTextMateReady(true));
  }, [filePath]);

  const refreshModelLanguage = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    const id = model.getLanguageId();
    if (id) {
      monaco.editor.setModelLanguage(model, id);
    }
  }, []);

  useEffect(() => {
    if (textMateReady) {
      refreshModelLanguage();
    }
  }, [textMateReady, editorLanguage, refreshModelLanguage]);

  const applyPreviewDiagnostics = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    applyPreviewMarkersToModel(model, previewErrors, filePath);
  }, [previewErrors, filePath]);

  useEffect(() => {
    applyPreviewDiagnostics();
    // v13.1: clear preview (dev-server) markers when switching files so they
    // don't leak across the shared Monaco model. (This reset previously lived
    // in the deleted LSP effect's cleanup.)
    return () => {
      const model = editorRef.current?.getModel();
      if (model) applyPreviewMarkersToModel(model, [], filePath);
    };
  }, [applyPreviewDiagnostics, value, filePath]);

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
    if (textMateReady) {
      refreshModelLanguage();
    }
    applyPreviewDiagnostics();
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

  if (needsTextMate && !textMateReady) {
    return (
      <div className="flex flex-col h-full">
        <Breadcrumb
          path={filePath}
          hasUnsavedChanges={displayUnsavedChanges}
          onSave={saveFile}
          isSaving={isSaving}
        />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading syntax highlighting…
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <Breadcrumb
        path={filePath}
        hasUnsavedChanges={displayUnsavedChanges}
        onSave={saveFile}
        isSaving={isSaving}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        <Editor
          key={`${filePath}:${editorLanguage}`}
          height="100%"
          language={editorLanguage}
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
            glyphMargin: true,
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
    </div>
  );
};
