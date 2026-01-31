/**
 * CodebaseSearchBox
 * ================
 * Quick codebase search with natural language, ±3 context, and Recent Searches.
 */

import { useState, useRef, useEffect } from "react";
import { useAtom } from "jotai";
import { recentCodeSearchesAtom } from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { Search, Loader2, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_RECENT = 10;

interface SearchResult {
  file: string;
  line: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
  score?: number;
}

interface SearchResponse {
  success: boolean;
  query?: string;
  results?: SearchResult[];
  formatted_with_context?: string;
  total_matches?: number;
  error?: string;
}

interface CodebaseSearchBoxProps {
  appId: number | null;
  className?: string;
  placeholder?: string;
  onResults?: (results: SearchResult[], query: string) => void;
}

export function CodebaseSearchBox({
  appId,
  className,
  placeholder = "Search codebase... e.g. 'authentication logic'",
  onResults,
}: CodebaseSearchBoxProps) {
  const [query, setQuery] = useState("");
  const [recentSearches, setRecentSearches] = useAtom(recentCodeSearchesAtom);
  const [isSearching, setIsSearching] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowRecent(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const addToRecent = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setRecentSearches((prev) => {
      const next = [trimmed, ...prev.filter((s) => s !== trimmed)].slice(0, MAX_RECENT);
      return next;
    });
  };

  const handleSearch = async (searchQuery?: string) => {
    const q = (searchQuery ?? query).trim();
    if (!q || !appId) return;

    setIsSearching(true);
    setLastError(null);
    setShowRecent(false);

    try {
      const res = (await IpcClient.getInstance().searchCodebase({
        query: q,
        appId,
        maxResults: 15,
      })) as SearchResponse;

      if (res.success && res.results) {
        addToRecent(q);
        onResults?.(res.results, q);
      } else {
        setLastError(res.error || "Search failed");
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectRecent = (q: string) => {
    setQuery(q);
    setShowRecent(false);
    inputRef.current?.focus();
    handleSearch(q);
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="flex gap-1">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setShowRecent(recentSearches.length > 0)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
              if (e.key === "Escape") setShowRecent(false);
            }}
            placeholder={placeholder}
            disabled={!appId}
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
          />
          {showRecent && recentSearches.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 py-1 rounded-md border border-border bg-popover shadow-lg z-50 max-h-48 overflow-y-auto">
              {recentSearches.map((q, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleSelectRecent(q)}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted truncate"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => handleSearch()}
          disabled={!query.trim() || !appId || isSearching}
          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        </button>
      </div>
      {lastError && (
        <p className="mt-1 text-xs text-destructive">{lastError}</p>
      )}
    </div>
  );
}
