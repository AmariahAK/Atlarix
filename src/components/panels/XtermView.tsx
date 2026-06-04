/**
 * XtermView (v10) — real interactive terminal for USER terminal tabs.
 * xterm.js frontend ↔ @lydell/node-pty backend via pty:* IPC. Native Tab
 * completion, arrows, colors, vim/top all work.
 *
 * Terminal instances live in a module-level cache so scrollback survives
 * React unmounts (tab switches, panel toggles). The PTY itself lives in the
 * main process and survives until the tab is closed or the app quits.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getDefaultStore } from "jotai";
import {
  devServerUrlAtom,
  previewTabAtom,
  rightPanelVisibleAtom,
} from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";

/** localhost-ish URLs open in the Preview tab; everything else in the browser. */
function isLocalDevUrl(uri: string): boolean {
  try {
    const { hostname } = new URL(uri);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Route a clicked terminal link: dev-server URLs → Preview tab (it's the
 * user's own app, iframe-safe); external URLs → system browser. Cmd/Ctrl+click
 * forces the browser for both.
 */
function handleTerminalLink(event: MouseEvent, uri: string): void {
  const forceBrowser = event.metaKey || event.ctrlKey;
  if (!forceBrowser && isLocalDevUrl(uri)) {
    const store = getDefaultStore();
    store.set(devServerUrlAtom, uri);
    store.set(previewTabAtom, "preview");
    store.set(rightPanelVisibleAtom, true);
    return;
  }
  void IpcClient.getInstance().openExternalUrl(uri);
}

type CachedTerm = {
  term: Terminal;
  fit: FitAddon;
  unsubData: () => void;
  unsubExit: () => void;
  exited: boolean;
};

const cache = new Map<string, CachedTerm>();

/** Tear down the renderer-side terminal for a closed tab. */
export function disposeXtermInstance(instanceId: string): void {
  const entry = cache.get(instanceId);
  if (!entry) return;
  cache.delete(instanceId);
  entry.unsubData();
  entry.unsubExit();
  try {
    entry.term.dispose();
  } catch {
    // already disposed
  }
}

function getOrCreateTerm(instanceId: string): CachedTerm {
  const existing = cache.get(instanceId);
  if (existing) return existing;

  const term = new Terminal({
    fontSize: 12,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#d4d4d4",
      selectionBackground: "#264f78",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Clickable links: localhost → Preview tab, external → browser (Cmd/Ctrl+click forces browser).
  term.loadAddon(new WebLinksAddon(handleTerminalLink));

  const ipc = IpcClient.getInstance();
  term.onData((data) => {
    ipc.sendPtyInput(instanceId, data);
  });
  const unsubData = ipc.onPtyData((payload) => {
    if (payload.instanceId === instanceId) term.write(payload.data);
  });
  const unsubExit = ipc.onPtyExit((payload) => {
    if (payload.instanceId !== instanceId) return;
    const entry = cache.get(instanceId);
    if (entry) entry.exited = true;
    term.write(`\r\n\x1b[90m[shell exited (${payload.exitCode})]\x1b[0m\r\n`);
  });

  const entry: CachedTerm = { term, fit, unsubData, unsubExit, exited: false };
  cache.set(instanceId, entry);
  return entry;
}

export function XtermView({
  instanceId,
  cwd,
  scopeKey,
  active,
  onSpawnFailed,
}: {
  instanceId: string;
  cwd: string;
  scopeKey: string;
  /** Only the visible tab fits + focuses. */
  active: boolean;
  /** PTY unavailable (native module failure) → caller falls back to the legacy input. */
  onSpawnFailed?: (error: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [exitedTick, setExitedTick] = useState(0);

  // Mount/attach the cached terminal and ensure the PTY exists.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const entry = getOrCreateTerm(instanceId);

    if (entry.term.element) {
      // Re-attach an existing terminal (tab switch / panel re-open).
      container.appendChild(entry.term.element);
    } else {
      entry.term.open(container);
    }

    let cancelled = false;
    const doSpawn = () => {
      try {
        entry.fit.fit();
      } catch {
        /* container not laid out yet */
      }
      void IpcClient.getInstance()
        .spawnPty({
          instanceId,
          cwd,
          cols: entry.term.cols,
          rows: entry.term.rows,
          scopeKey,
        })
        .then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            setSpawnError(result.error);
            onSpawnFailed?.(result.error);
          } else {
            entry.exited = false;
            setSpawnError(null);
          }
        });
    };
    doSpawn();

    const unsubExitLocal = IpcClient.getInstance().onPtyExit((payload) => {
      if (payload.instanceId === instanceId) setExitedTick((t) => t + 1);
    });

    return () => {
      cancelled = true;
      unsubExitLocal();
      // Detach (keep buffer); the PTY + cached term survive for re-attach.
      if (entry.term.element && entry.term.element.parentElement === container) {
        container.removeChild(entry.term.element);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, cwd, scopeKey]);

  // Fit + notify the PTY when the visible size changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    const entry = cache.get(instanceId);
    if (!entry) return;
    const doFit = () => {
      try {
        entry.fit.fit();
        IpcClient.getInstance().sendPtyResize(
          instanceId,
          entry.term.cols,
          entry.term.rows,
        );
      } catch {
        /* ignore */
      }
    };
    doFit();
    entry.term.focus();
    const observer = new ResizeObserver(() => doFit());
    observer.observe(container);
    return () => observer.disconnect();
  }, [instanceId, active]);

  const entry = cache.get(instanceId);
  const exited = (entry?.exited ?? false) && exitedTick >= 0;

  const handleRestart = () => {
    const cached = cache.get(instanceId);
    void IpcClient.getInstance()
      .spawnPty({
        instanceId,
        cwd,
        cols: cached?.term.cols,
        rows: cached?.term.rows,
        scopeKey,
      })
      .then((result) => {
        if (result.ok && cached) {
          cached.exited = false;
          setExitedTick((t) => t + 1);
          cached.term.focus();
        } else if (!result.ok) {
          setSpawnError(result.error);
          onSpawnFailed?.(result.error);
        }
      });
  };

  if (spawnError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
        <p className="text-xs text-zinc-400">
          Interactive shell unavailable: {spawnError}
        </p>
        <p className="text-[11px] text-zinc-500">
          Falling back to single-command mode below.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full px-2 pt-1" />
      {exited ? (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
          <Button size="sm" variant="secondary" className="h-6 text-[11px]" onClick={handleRestart}>
            Restart shell
          </Button>
        </div>
      ) : null}
    </div>
  );
}
