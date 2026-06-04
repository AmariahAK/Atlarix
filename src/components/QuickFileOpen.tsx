/**
 * QuickFileOpen — Cmd/Ctrl+P fuzzy file opener for the current workspace.
 * Reuses the Code tab's `app-files` query and opens the selected file in the
 * right-panel Code tab via the same atoms the file tree uses.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { FileCode2 } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { IpcClient } from "@/ipc/ipc_client";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import {
  aiPanelIntentAtom,
  previewTabAtom,
  rightPanelSuppressAutoOpenAtom,
  rightPanelVisibleAtom,
  selectedErrorForCodeAtom,
} from "@/atoms/sourceAtoms";

const MAX_RESULTS = 50;

/** Same fuzzy scorer as AppSearchDialog: substring with early-match boost. */
function fileFilter(value: string, search: string): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const v = (value || "").toLowerCase();
  const base = v.split("/").pop() ?? v;
  // Basename matches rank above directory matches.
  if (base.includes(q)) return 200 - Math.max(0, base.indexOf(q));
  if (v.includes(q)) return 100 - Math.min(99, v.indexOf(q));
  return 0;
}

export function QuickFileOpen() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const appId = useAtomValue(selectedAppIdAtom);
  const setSelectedErrorForCode = useSetAtom(selectedErrorForCodeAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setAIPanelIntent = useSetAtom(aiPanelIntentAtom);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const mod =
        typeof navigator !== "undefined" &&
        navigator.platform?.toLowerCase().startsWith("mac")
          ? e.metaKey
          : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault(); // suppress the print dialog
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  // Same query key as the Code tab tree — shared cache, no extra scans.
  const { data: appFilesData } = useQuery({
    queryKey: ["app-files", appId],
    queryFn: async () => {
      if (appId == null) return null;
      return IpcClient.getInstance().getAppFiles(appId);
    },
    enabled: appId != null && open,
    staleTime: 5_000,
  });
  const files = appFilesData?.files ?? [];

  // cmdk scores every item; pre-trim the visible list for huge repos.
  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files.slice(0, MAX_RESULTS);
    return files
      .map((f) => ({ f, score: fileFilter(f, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((x) => x.f);
  }, [files, query]);

  const openFile = (filePath: string) => {
    setOpen(false);
    setQuery("");
    setSelectedErrorForCode({ filePath });
    // Same wiring the sidebar file tree used: open right panel on the Code tab.
    setSuppressRightAutoOpen(false);
    setRightPanelVisible(true);
    setPreviewTab("code");
    setAIPanelIntent({
      intent: "show-preview",
      timestamp: Date.now(),
      source: "user",
    });
  };

  if (appId == null) return null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
      title="Go to file"
      description="Fuzzy-search workspace files"
      // We pre-filter + sort ourselves; neutralize cmdk's own filter.
      filter={() => 1}
    >
      <CommandInput
        placeholder="Go to file…"
        value={query}
        onValueChange={setQuery}
        data-testid="quick-file-open-input"
      />
      <CommandList data-testid="quick-file-open-list">
        <CommandEmpty>
          {files.length === 0 ? "No files indexed yet." : "No matching files."}
        </CommandEmpty>
        {visibleFiles.map((f) => {
          const base = f.split("/").pop() ?? f;
          const dir = f.slice(0, f.length - base.length).replace(/\/$/, "");
          return (
            <CommandItem key={f} value={f} onSelect={() => openFile(f)}>
              <FileCode2 className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{base}</span>
              {dir ? (
                <span className="ml-auto truncate text-xs text-muted-foreground">
                  {dir}
                </span>
              ) : null}
            </CommandItem>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
