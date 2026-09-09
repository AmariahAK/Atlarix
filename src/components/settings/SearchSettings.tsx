/**
 * Search Settings
 * ===============
 * Web search runs through Atlarix's own Chromium (`lib/search/browser-search.ts`),
 * so there is nothing here for a normal user to configure — this panel exists for
 * the one case the browser cannot cover.
 *
 * WHY THIS REPLACED THE DOCKER SETUP
 * ----------------------------------
 * v14.35.0 measured the search chain: the browser tier returned 24/29/25 results
 * on three developer queries where DuckDuckGo and all five public SearxNG
 * instances returned 0. The Docker auto-setup that used to live here — ~650 lines
 * of container orchestration across a handler and a wizard — existed to rescue a
 * tier that a real browser made unnecessary, so it was deleted.
 *
 * WHAT STAYS, AND WHY
 * -------------------
 * A plain URL field for a SearxNG the user ALREADY runs. Two reasons it earns its
 * place: it is unmetered and private for someone who wants that, and it is the
 * only search the HEADLESS build can reach — headless stubs Electron and has no
 * browser at all, so without this it has nothing that returns results.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle, XCircle, Info } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; resultsCount?: number }
  | { kind: "failed"; error: string };

/** Accept a bare host and normalise it, so "localhost:8080" is not an error. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function SearchSettings() {
  const [url, setUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await IpcClient.getInstance().getSearxngConfig();
        if (cancelled) return;
        setSavedUrl(cfg.enabled ? cfg.url : null);
        setUrl(cfg.url ?? "");
      } catch {
        /* no config is the normal case — the browser tier needs none */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Test and save are one action: saving a URL that was never reached is how a
  // user ends up with a silently dead tier and no idea which layer broke.
  const handleSave = useCallback(async () => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    setTest({ kind: "testing" });
    try {
      const health =
        await IpcClient.getInstance().checkSearxngHealth(normalized);
      if (!health.success) {
        setTest({
          kind: "failed",
          error: health.error ?? "No response from that URL.",
        });
        return;
      }
      await IpcClient.getInstance().syncSearxngConfig({
        url: normalized,
        enabled: true,
      });
      setSavedUrl(normalized);
      setUrl(normalized);
      setTest({ kind: "ok", resultsCount: health.resultsCount });
    } catch (e) {
      setTest({
        kind: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [url]);

  const handleClear = useCallback(async () => {
    try {
      await IpcClient.getInstance().deleteSearxngConfig();
    } finally {
      setSavedUrl(null);
      setUrl("");
      setTest({ kind: "idle" });
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Loading search settings…
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Web search works out of the box — Atlarix searches using its own
          built-in browser, so there is nothing to install or configure.
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="searxng-url"
          className="text-sm font-medium text-foreground"
        >
          Self-hosted SearxNG{" "}
          <span className="text-muted-foreground">(optional)</span>
        </label>
        <p className="text-sm text-muted-foreground">
          Already run your own SearxNG? Point Atlarix at it and searches will go
          there instead. This is also the only search available to the headless
          CLI, which has no browser.
        </p>
        <div className="flex gap-2">
          <Input
            id="searxng-url"
            value={url}
            placeholder="http://localhost:8080"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setUrl(e.target.value);
              setTest({ kind: "idle" });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSave();
            }}
          />
          <Button
            onClick={() => void handleSave()}
            disabled={test.kind === "testing" || !url.trim()}
            className="gap-2 whitespace-nowrap"
          >
            {test.kind === "testing" && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {test.kind === "testing" ? "Testing…" : "Test & Save"}
          </Button>
          {savedUrl && (
            <Button variant="ghost" onClick={() => void handleClear()}>
              Clear
            </Button>
          )}
        </div>

        {test.kind === "ok" && (
          <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <CheckCircle className="h-4 w-4" />
            Connected and saved
            {typeof test.resultsCount === "number" &&
              ` — test query returned ${test.resultsCount} results`}
          </p>
        )}
        {test.kind === "failed" && (
          <p className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
            <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              Could not reach that URL — {test.error} Search will keep using the
              built-in browser.
            </span>
          </p>
        )}
        {savedUrl && test.kind === "idle" && (
          <p className="text-sm text-muted-foreground">
            Currently using{" "}
            <span className="font-mono text-foreground">{savedUrl}</span>
          </p>
        )}
      </div>
    </div>
  );
}
