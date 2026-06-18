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
  defaultAgentInstanceLabel,
  defaultUserInstanceLabel,
} from "@/lib/terminal-instances";
import { capTerminalLines } from "@/lib/chat/terminal-line-buffer";
import { linesToModelText } from "@/lib/chat/terminal-line-format";
import { getUserDataPath } from "@/paths/paths";

export const MAX_AGENT_TERMINALS_PER_SCOPE = 3;

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
  },
) {
  const scope = getScope(scopeKey);

  if (opts.owner === "agent" && opts.operationId) {
    const existingId = scope.agentOpMap[opts.operationId];
    if (existingId && scope.instances.some((i) => i.id === existingId)) {
      scope.activeInstanceId = existingId;
      broadcastScope(scopeKey);
      return { success: true as const, instanceId: existingId, created: false };
    }
  }

  if (opts.owner === "agent") {
    const agentCount = scope.instances.filter((i) => i.owner === "agent").length;
    if (agentCount >= MAX_AGENT_TERMINALS_PER_SCOPE) {
      return {
        success: false as const,
        error: `Maximum ${MAX_AGENT_TERMINALS_PER_SCOPE} agent terminals per scope. Close one with close_terminal_instance first.`,
      };
    }
  }

  const id = `${opts.owner}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const label =
    opts.label?.trim() ||
    (opts.owner === "user"
      ? defaultUserInstanceLabel(scope.instances)
      : defaultAgentInstanceLabel(opts.commandHint ?? "", scope.instances));

  const inst: TerminalInstance = {
    id,
    label,
    owner: opts.owner,
    lines: [],
    createdAt: Date.now(),
  };
  scope.instances.push(inst);
  if (opts.operationId) {
    scope.agentOpMap[opts.operationId] = id;
  }
  scope.activeInstanceId = id;
  schedulePersist();
  broadcastScope(scopeKey);
  return { success: true as const, instanceId: id, created: true, label };
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
