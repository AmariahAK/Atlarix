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

/**
 * Apply the RENDERER's view of a scope — user tabs only.
 *
 * The two sides own different halves and must not overwrite each other's:
 * the renderer owns user tabs (it has the PTYs and the live cwd), main owns
 * agent instances and the `agentOpMap` (it runs the commands and buffers their
 * output for `background_jobs`).
 *
 * This used to replace the whole scope wholesale, which was survivable only
 * while the panel also created agent instances and mirrored them back. Since
 * v14.27.0 it does neither — the agent has no tabs in the UI — so a wholesale
 * replace would delete main's agent instances and its `agentOpMap` on the first
 * sync, and `appendAgentCommandOutput` would then silently find no instance to
 * append to. Agent state is preserved here regardless of what the renderer
 * sends.
 */
export function setTerminalScopeState(
  scopeKey: string,
  state: TerminalScopeState,
): void {
  ensureLoadedFromDisk();
  const existing = scopes.get(scopeKey);
  const agentInstances = (existing?.instances ?? []).filter(
    (i) => i.owner === "agent",
  );
  const userInstances = state.instances
    .filter((i) => i.owner === "user")
    .map((i) => ({ ...i, lines: capTerminalLines(i.lines) }));

  const merged: TerminalScopeState = {
    instances: [...userInstances, ...agentInstances],
    activeInstanceId: state.activeInstanceId,
    // Main's map, never the renderer's — it no longer keeps one.
    agentOpMap: existing?.agentOpMap ?? {},
  };
  scopes.set(scopeKey, cloneScope(merged));
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

/**
 * The retained agent buffer a finished job's output is in, or null.
 *
 * Lives here, exported, because `background_jobs` used to resolve it inline and
 * its test re-implemented the same three-step match by hand — so when the tool's
 * copy searched every instance including the USER's shells, the mirrored copy
 * did too and agreed with it. Two wrong implementations that validate each other
 * are worse than one.
 *
 * `owner === "agent"` is the whole point: user tabs are labelled by their last
 * command (`userTabLabelFromInstance`), so a substring match across all
 * instances would return a shell the user was typing in.
 */
export function findAgentBuffer(scopeKey: string, wanted: string) {
  const buffers = listTerminalInstances(scopeKey).filter(
    (t) => t.owner === "agent",
  );
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;
  // The shared tab is identified through `agentOpMap`, not by its instance id —
  // `AGENT_FG_KEY` is the reserved MAP key, and the instance behind it has an
  // ordinary generated id like every other.
  const sharedId = sharedForegroundInstanceId(scopeKey);
  const hit =
    buffers.find((t) => t.id === wanted) ??
    buffers.find((t) => t.label.toLowerCase() === needle) ??
    buffers.find((t) => t.label.toLowerCase().includes(needle)) ??
    // Foreground commands share one buffer whose label is "Agent" and so matches
    // no command name. It is still where the output is.
    buffers.find((t) => t.id === sharedId && t.lineCount > 0);
  if (!hit) return null;
  return { ...hit, shared: hit.id === sharedId };
}

/** The instance every foreground agent command writes to, if one exists yet. */
export function sharedForegroundInstanceId(scopeKey: string): string | null {
  return getScope(scopeKey).agentOpMap[AGENT_FG_KEY] ?? null;
}

/** Agent buffers that are named after a command — the shared one is not. */
export function listRetainedAgentCommands(scopeKey: string) {
  const sharedId = sharedForegroundInstanceId(scopeKey);
  return listTerminalInstances(scopeKey).filter(
    (t) => t.owner === "agent" && t.id !== sharedId,
  );
}

/**
 * Record a command's output against its agent instance.
 *
 * MAIN OWNS THIS NOW. It used to be the renderer's job: `TerminalPanel` listened
 * to `terminal-output`, built the lines, and pushed them back down through
 * `terminal-instances:sync-scope`. Main created every instance with `lines: []`
 * and never filled them itself.
 *
 * That made the buffer depend on a mounted component — and `TerminalPanel` only
 * mounts while the Terminal tab is SELECTED (`RightPanel.tsx`). So
 * `background_jobs({operation:"read"})` silently returned nothing for anyone who
 * had not opened the panel: the agent asked what its dev server had printed and
 * was told nothing had been printed. Main has the output at the moment it
 * happens; it now keeps it, and the answer no longer depends on what the user
 * happens to be looking at.
 *
 * Idempotent per chunk, matching the renderer logic it replaces: output ids are
 * keyed on the accumulated length so a re-emitted chunk replaces rather than
 * duplicates.
 */
export function appendAgentCommandOutput(
  scopeKey: string,
  args: {
    operationId: string;
    command: string;
    output: string;
    status: "running" | "completed" | "error";
  },
): void {
  const scope = getScope(scopeKey);
  // Resolve through the same `agentOpMap` the open path writes, so callers only
  // need the operation id they already have — no instance id threaded through
  // every emit site.
  const instanceId = scope.agentOpMap[args.operationId];
  const inst = instanceId
    ? scope.instances.find((i) => i.id === instanceId)
    : undefined;
  if (!inst) return;

  const lines = inst.lines.filter(
    (l) => !l.id.startsWith(`${args.operationId}-out-`),
  );
  if (!lines.some((l) => l.id === `${args.operationId}-cmd`)) {
    lines.push({
      id: `${args.operationId}-cmd`,
      prefix: "[Agent]",
      text: `$ ${args.command}`,
      kind: "prompt",
    });
  }
  if (args.output.trim()) {
    // One entry PER LINE, not one entry per chunk.
    //
    // `readTerminalInstance(maxLines)` and `capTerminalLines` both slice by
    // entry, so a chunk carrying 900 newlines in a single entry defeated both:
    // asking for 50 lines returned 900. That matters because this is what
    // `background_jobs({operation:"read"})` puts in the context window — an
    // unbounded dev-server log would land there whole. Ids stay keyed on the
    // accumulated length so a re-emitted chunk still supersedes its predecessor.
    const chunk = args.output.replace(/\n+$/, "").split("\n");
    chunk.forEach((text, i) => {
      lines.push({
        id: `${args.operationId}-out-${args.output.length}-${i}`,
        prefix: "[Agent]",
        text,
        kind: "output",
      });
    });
  }
  if (args.status === "completed" || args.status === "error") {
    if (!lines.some((l) => l.id === `${args.operationId}-st`)) {
      lines.push({
        id: `${args.operationId}-st`,
        prefix: "[Agent]",
        text: args.status === "completed" ? "exit 0" : "failed",
        kind: "status",
      });
    }
  }
  inst.lines = capTerminalLines(lines);
  schedulePersist();
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
