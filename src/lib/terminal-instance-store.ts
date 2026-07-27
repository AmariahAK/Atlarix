/**
 * Main-process terminal instance state (tools + IPC bridge).
 */

import { randomUUID } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import type { TerminalInstance } from "@/atoms/terminalInstancesAtoms";
import { terminalScopeKey } from "@/atoms/terminalInstancesAtoms";
import {
  AGENT_FG_KEY,
  AGENT_FG_LABEL,
  defaultAgentInstanceLabel,
  defaultUserInstanceLabel,
} from "@/lib/terminal-instances";
import { capTerminalLines } from "@/lib/chat/terminal-line-buffer";
import { linesToModelText } from "@/lib/chat/terminal-line-format";
import { getUserDataPath } from "@/paths/paths";

// MAX_AGENT_TERMINALS_PER_SCOPE (was 3) REMOVED. It existed to bound a sprawl
// that only happened because main created one instance per command; with
// foreground commands sharing a tab and background jobs earning their own, the
// count now tracks concurrent background work, which is exactly what should be
// visible. Its only remaining effect was a silent failure: the fourth agent
// terminal returned an error that the caller (interceptor.executeRunCommand)
// discarded, so the command ran with nowhere to show its output.

export type TerminalScopeState = {
  instances: TerminalInstance[];
  activeInstanceId: string | null;
  agentOpMap: Record<string, string>;
};

const scopes = new Map<string, TerminalScopeState>();

// ── Disk persistence (v10.1) ─────────────────────────────────────────────
// Tabs + line buffers survive app restarts; PTY scrollback is persisted
// separately per instance (see pty_handlers scrollback channels).

function persistFile(): string {
  return path.join(getUserDataPath(), "terminal-scopes.json");
}

let loadedFromDisk = false;
let persistTimer: NodeJS.Timeout | null = null;

function ensureLoadedFromDisk(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const raw = fs.readFileSync(persistFile(), "utf8");
    const data = JSON.parse(raw) as Record<string, TerminalScopeState>;
    for (const [key, state] of Object.entries(data)) {
      if (scopes.has(key)) continue; // never clobber live state
      if (!state || !Array.isArray(state.instances)) continue;
      scopes.set(key, {
        instances: state.instances.map((i) => ({
          ...i,
          lines: capTerminalLines(Array.isArray(i.lines) ? i.lines : []),
        })),
        activeInstanceId: state.activeInstanceId ?? null,
        agentOpMap: state.agentOpMap ?? {},
      });
    }
  } catch {
    // first run / corrupt file — start fresh
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const file = persistFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(scopes)));
    } catch {
      // best-effort persistence
    }
  }, 800);
}

function emptyScope(): TerminalScopeState {
  return { instances: [], activeInstanceId: null, agentOpMap: {} };
}

function cloneScope(state: TerminalScopeState): TerminalScopeState {
  return {
    instances: state.instances.map((i) => ({
      ...i,
      lines: [...i.lines],
    })),
    activeInstanceId: state.activeInstanceId,
    agentOpMap: { ...state.agentOpMap },
  };
}

function getScope(scopeKey: string): TerminalScopeState {
  ensureLoadedFromDisk();
  let state = scopes.get(scopeKey);
  if (!state) {
    state = emptyScope();
    scopes.set(scopeKey, state);
  }
  return state;
}

function broadcastScope(scopeKey: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("terminal-instances:updated", { scopeKey });
  }
}

export function resolveScopeKey(
  chatId?: number | null,
  appId?: number | null,
): string {
  return terminalScopeKey(chatId, appId);
}

export function getTerminalScopeState(scopeKey: string): TerminalScopeState {
  ensureLoadedFromDisk();
  const state = scopes.get(scopeKey);
  return state ? cloneScope(state) : emptyScope();
}

export function setTerminalScopeState(
  scopeKey: string,
  state: TerminalScopeState,
): void {
  ensureLoadedFromDisk();
  const capped: TerminalScopeState = {
    ...state,
    instances: state.instances.map((i) => ({
      ...i,
      lines: capTerminalLines(i.lines),
    })),
  };
  scopes.set(scopeKey, cloneScope(capped));
  schedulePersist();
}

export function clearAllTerminalScopes(): void {
  ensureLoadedFromDisk();
  scopes.clear();
  schedulePersist();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("terminal-instances:cleared", {});
  }
}

export function listTerminalInstances(scopeKey: string) {
  const { instances, activeInstanceId } = getScope(scopeKey);
  return instances.map((i) => ({
    id: i.id,
    label: i.label,
    owner: i.owner,
    lineCount: i.lines.length,
    active: i.id === activeInstanceId,
    createdAt: i.createdAt,
  }));
}

export function readTerminalInstance(
  scopeKey: string,
  instanceId: string,
  maxLines = 600,
) {
  const inst = getScope(scopeKey).instances.find((i) => i.id === instanceId);
  if (!inst) {
    return { success: false as const, error: `Terminal instance not found: ${instanceId}` };
  }
  const slice = inst.lines.slice(-Math.max(1, maxLines));
  return {
    success: true as const,
    instanceId: inst.id,
    owner: inst.owner,
    label: inst.label,
    lineCount: inst.lines.length,
    text: linesToModelText(slice),
  };
}

export function openTerminalInstance(
  scopeKey: string,
  opts: {
    owner: "user" | "agent";
    label?: string;
    commandHint?: string;
    operationId?: string;
    /**
     * Detached job (dev server, watcher, long build). Background work earns its
     * OWN tab so it can keep printing without interleaving into the session the
     * agent is reading; foreground commands share one tab.
     */
    background?: boolean;
    /**
     * Explicit target: an existing instance id, or a LABEL that is created once
     * and reused thereafter (`terminal: "e2e"`). Lets the agent keep separate
     * streams — a dev server in one, tests in another — without a tab per
     * command. Wins over the shared-foreground rule.
     */
    terminal?: string;
  },
) {
  const scope = getScope(scopeKey);

  // An explicit target beats every default. Matched on id first, then label, so
  // "run this in the e2e terminal" reuses the one it made last time instead of
  // stacking up tabs with the same name.
  if (opts.owner === "agent" && opts.terminal?.trim()) {
    const wanted = opts.terminal.trim();
    const existing =
      scope.instances.find((i) => i.id === wanted) ??
      scope.instances.find(
        (i) => i.owner === "agent" && i.label.toLowerCase() === wanted.toLowerCase(),
      );
    if (existing) {
      if (opts.operationId) scope.agentOpMap[opts.operationId] = existing.id;
      scope.activeInstanceId = existing.id;
      schedulePersist();
      broadcastScope(scopeKey);
      return { success: true as const, instanceId: existing.id, created: false };
    }
    // Unknown target — create it under that name rather than failing. A typo
    // costs a tab, whereas rejecting would cost the command.
    return createInstanceInScope(scopeKey, scope, {
      owner: "agent",
      label: wanted,
      operationId: opts.operationId,
      registerAsSharedForeground: false,
    });
  }

  if (opts.owner === "agent" && opts.operationId) {
    const existingId = scope.agentOpMap[opts.operationId];
    if (existingId && scope.instances.some((i) => i.id === existingId)) {
      scope.activeInstanceId = existingId;
      broadcastScope(scopeKey);
      return { success: true as const, instanceId: existingId, created: false };
    }
  }

  // FOREGROUND AGENT COMMANDS SHARE ONE TAB.
  //
  // This rule already existed in TerminalPanel (AGENT_FG_KEY) but only there, so
  // main ran its own policy at the same time: a fresh `operationId` per command
  // meant the reuse branch above could never hit, and main created a new
  // instance for EVERY command. Those extras flowed back into the panel through
  // the bidirectional scope sync — the pile of tabs. Past three, main returned
  // an error the caller discarded, so it then failed silently instead.
  //
  // The renderer syncs its `agentOpMap` here, so when a panel is open this
  // resolves to the tab the user is already looking at and main adds nothing.
  // With no panel (headless, automations) main creates it once and reuses it.
  if (opts.owner === "agent" && !opts.background) {
    const fgId = scope.agentOpMap[AGENT_FG_KEY];
    if (fgId && scope.instances.some((i) => i.id === fgId)) {
      if (opts.operationId) scope.agentOpMap[opts.operationId] = fgId;
      scope.activeInstanceId = fgId;
      schedulePersist();
      broadcastScope(scopeKey);
      return { success: true as const, instanceId: fgId, created: false };
    }
  }

  const isSharedForeground = opts.owner === "agent" && !opts.background;
  return createInstanceInScope(scopeKey, scope, {
    owner: opts.owner,
    label:
      opts.label?.trim() ||
      (opts.owner === "user"
        ? defaultUserInstanceLabel(scope.instances)
        : isSharedForeground
          // Named for the session, not the command that happened to open it —
          // every later foreground command lands in this same tab.
          ? AGENT_FG_LABEL
          : defaultAgentInstanceLabel(opts.commandHint ?? "", scope.instances)),
    operationId: opts.operationId,
    registerAsSharedForeground: isSharedForeground,
  });
}

/** Append a new instance to an already-resolved scope. */
function createInstanceInScope(
  scopeKey: string,
  scope: TerminalScopeState,
  opts: {
    owner: "user" | "agent";
    label: string;
    operationId?: string;
    /** Point AGENT_FG_KEY at this instance so later foreground commands find it. */
    registerAsSharedForeground: boolean;
  },
) {
  const id = `${opts.owner}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const inst: TerminalInstance = {
    id,
    label: opts.label,
    owner: opts.owner,
    lines: [],
    createdAt: Date.now(),
  };
  scope.instances.push(inst);
  if (opts.operationId) {
    scope.agentOpMap[opts.operationId] = id;
  }
  // The pointer is what makes reuse work across operationIds.
  if (opts.registerAsSharedForeground) {
    scope.agentOpMap[AGENT_FG_KEY] = id;
  }
  scope.activeInstanceId = id;
  schedulePersist();
  broadcastScope(scopeKey);
  return { success: true as const, instanceId: id, created: true, label: opts.label };
}

export function closeTerminalInstance(scopeKey: string, instanceId: string) {
  const scope = getScope(scopeKey);
  const target = scope.instances.find((i) => i.id === instanceId);
  if (!target) {
    return { success: false as const, error: `Terminal instance not found: ${instanceId}` };
  }
  const userCount = scope.instances.filter((i) => i.owner === "user").length;
  if (target.owner === "user" && userCount <= 1) {
    return { success: false as const, error: "Cannot close the last user shell." };
  }
  if (scope.instances.length <= 1) {
    return { success: false as const, error: "Cannot close the last terminal." };
  }

  scope.instances = scope.instances.filter((i) => i.id !== instanceId);
  for (const [op, instId] of Object.entries(scope.agentOpMap)) {
    if (instId === instanceId) delete scope.agentOpMap[op];
  }
  if (scope.activeInstanceId === instanceId) {
    scope.activeInstanceId = scope.instances[0]?.id ?? null;
  }
  schedulePersist();
  broadcastScope(scopeKey);
  return { success: true as const, instanceId };
}
