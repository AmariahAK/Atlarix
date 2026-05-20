/**
 * Interactive terminal panel — multiple persisted instances (user + agent).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { terminalOutputsAtom, type TerminalOutput } from "@/atoms/sourceAtoms";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import {
  currentAppAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import {
  activeTerminalInstanceByScopeAtom,
  terminalAgentOpMapByScopeAtom,
  terminalDraftByScopeAtom,
  terminalInstancesByScopeAtom,
  terminalScopeKey,
  type TerminalInstance,
  type TerminalLine,
} from "@/atoms/terminalInstancesAtoms";
import {
  defaultAgentInstanceLabel,
  defaultUserInstanceLabel,
} from "@/lib/terminal-instances";
import { IpcClient } from "@/ipc/ipc_client";
import { Terminal, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function shortenPath(fullPath: string): string {
  const m = fullPath.match(/^\/Users\/[^/]+(.*)$/);
  if (m) return `~${m[1] || ""}`;
  const win = fullPath.match(/^[A-Za-z]:\\Users\\[^\\]+(.*)$/);
  if (win) return `~${win[1].replace(/\\/g, "/") || ""}`;
  return fullPath;
}

function mergeLines(prev: TerminalLine[], add: TerminalLine[]): TerminalLine[] {
  return [...prev, ...add];
}

function upsertAgentOutputLines(
  instances: TerminalInstance[],
  instanceId: string,
  operationId: string,
  command: string,
  output: string,
  status: TerminalOutput["status"],
): TerminalInstance[] {
  return instances.map((inst) => {
    if (inst.id !== instanceId) return inst;
    const withoutDup = inst.lines.filter(
      (l) => !l.id.startsWith(`${operationId}-out-`),
    );
    const hasPrompt = inst.lines.some((l) => l.id === `${operationId}-cmd`);
    let lines = withoutDup;
    if (!hasPrompt) {
      lines = mergeLines(lines, [
        {
          id: `${operationId}-cmd`,
          prefix: "[Agent]",
          text: `$ ${command}`,
          kind: "prompt",
        },
      ]);
    }
    if (output.trim()) {
      lines = mergeLines(lines, [
        {
          id: `${operationId}-out-${output.length}`,
          prefix: "[Agent]",
          text: output,
          kind: "output",
        },
      ]);
    }
    if (status === "completed" || status === "error") {
      lines = mergeLines(lines, [
        {
          id: `${operationId}-st`,
          prefix: "[Agent]",
          text: status === "completed" ? "exit 0" : "failed",
          kind: "status",
        },
      ]);
    }
    return { ...inst, lines };
  });
}

export function TerminalPanel() {
  const terminalOutputs = useAtomValue(terminalOutputsAtom);
  const chatId = useAtomValue(selectedChatIdAtom);
  const workspace = useAtomValue(selectedWorkspaceInfoAtom);
  const currentApp = useAtomValue(currentAppAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);

  const scopeKey = terminalScopeKey(chatId, selectedAppId ?? currentApp?.id);
  const [instancesByScope, setInstancesByScope] = useAtom(
    terminalInstancesByScopeAtom,
  );
  const [activeByScope, setActiveByScope] = useAtom(
    activeTerminalInstanceByScopeAtom,
  );
  const [agentOpMapByScope, setAgentOpMapByScope] = useAtom(
    terminalAgentOpMapByScopeAtom,
  );
  const [draftByScope, setDraftByScope] = useAtom(terminalDraftByScopeAtom);

  const instances = instancesByScope[scopeKey] ?? [];
  const activeId = activeByScope[scopeKey];
  const activeInstance =
    instances.find((i) => i.id === activeId) ?? instances[0];

  const [running, setRunning] = useState(false);
  const activeIdForDraft = activeByScope[scopeKey] ?? activeInstance?.id ?? "";
  const input = draftByScope[scopeKey]?.[activeIdForDraft] ?? "";
  const setInput = useCallback(
    (value: string) => {
      if (!activeIdForDraft) return;
      setDraftByScope((prev) => ({
        ...prev,
        [scopeKey]: { ...(prev[scopeKey] ?? {}), [activeIdForDraft]: value },
      }));
    },
    [activeIdForDraft, scopeKey, setDraftByScope],
  );
  const seenOps = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const workspacePath = useMemo(() => {
    if (workspace?.path) return workspace.path;
    if (
      currentApp?.path &&
      (selectedAppId == null || currentApp.id === selectedAppId)
    ) {
      return currentApp.path;
    }
    return undefined;
  }, [workspace?.path, currentApp?.path, currentApp?.id, selectedAppId]);

  const cwdLabel = useMemo(() => {
    if (!workspacePath) return "~ $";
    return `${shortenPath(workspacePath)} $`;
  }, [workspacePath]);

  const ensureDefaultInstance = useCallback(() => {
    if ((instancesByScope[scopeKey]?.length ?? 0) > 0) return;
    const id = `user-${Date.now()}`;
    const inst: TerminalInstance = {
      id,
      label: "Shell 1",
      owner: "user",
      lines: [],
      createdAt: Date.now(),
    };
    setInstancesByScope((prev) => ({
      ...prev,
      [scopeKey]: [inst],
    }));
    setActiveByScope((prev) => ({ ...prev, [scopeKey]: id }));
  }, [scopeKey, instancesByScope, setInstancesByScope, setActiveByScope]);

  useEffect(() => {
    ensureDefaultInstance();
  }, [ensureDefaultInstance, scopeKey]);

  const setInstances = useCallback(
    (updater: (list: TerminalInstance[]) => TerminalInstance[]) => {
      setInstancesByScope((prev) => ({
        ...prev,
        [scopeKey]: updater(prev[scopeKey] ?? []),
      }));
    },
    [scopeKey, setInstancesByScope],
  );

  const createInstance = useCallback(
    (owner: "user" | "agent", label?: string, commandHint?: string) => {
      const list = instancesByScope[scopeKey] ?? [];
      const id = `${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const inst: TerminalInstance = {
        id,
        label:
          label ??
          (owner === "user"
            ? defaultUserInstanceLabel(list)
            : defaultAgentInstanceLabel(commandHint ?? "", list)),
        owner,
        lines: [],
        createdAt: Date.now(),
      };
      setInstances((prev) => [...prev, inst]);
      setActiveByScope((prev) => ({ ...prev, [scopeKey]: id }));
      return id;
    },
    [instancesByScope, scopeKey, setInstances, setActiveByScope],
  );

  const deleteInstance = useCallback(
    (instanceId: string) => {
      const list = instancesByScope[scopeKey] ?? [];
      const target = list.find((i) => i.id === instanceId);
      if (!target) return;
      const userCount = list.filter((i) => i.owner === "user").length;
      if (target.owner === "user" && userCount <= 1) return;
      if (list.length <= 1) return;
      const next = list.filter((i) => i.id !== instanceId);
      setInstancesByScope((prev) => ({ ...prev, [scopeKey]: next }));
      if (activeByScope[scopeKey] === instanceId) {
        setActiveByScope((prev) => ({
          ...prev,
          [scopeKey]: next[0]?.id ?? "",
        }));
      }
      setAgentOpMapByScope((prev) => {
        const map = { ...(prev[scopeKey] ?? {}) };
        for (const [op, inst] of Object.entries(map)) {
          if (inst === instanceId) delete map[op];
        }
        return { ...prev, [scopeKey]: map };
      });
      setDraftByScope((prev) => {
        const scopeDrafts = { ...(prev[scopeKey] ?? {}) };
        delete scopeDrafts[instanceId];
        return { ...prev, [scopeKey]: scopeDrafts };
      });
    },
    [
      instancesByScope,
      scopeKey,
      activeByScope,
      setInstancesByScope,
      setActiveByScope,
      setAgentOpMapByScope,
      setDraftByScope,
    ],
  );

  const appendToInstance = useCallback(
    (instanceId: string, lines: TerminalLine[]) => {
      setInstances((prev) =>
        prev.map((inst) =>
          inst.id === instanceId
            ? { ...inst, lines: mergeLines(inst.lines, lines) }
            : inst,
        ),
      );
    },
    [setInstances],
  );

  const getOrCreateAgentInstance = useCallback(
    (operationId: string, command: string) => {
      const map = agentOpMapByScope[scopeKey] ?? {};
      let instanceId = map[operationId];
      if (!instanceId) {
        instanceId = createInstance(
          "agent",
          defaultAgentInstanceLabel(
            command,
            instancesByScope[scopeKey] ?? [],
          ),
          command,
        );
        setAgentOpMapByScope((prev) => ({
          ...prev,
          [scopeKey]: { ...(prev[scopeKey] ?? {}), [operationId]: instanceId! },
        }));
      }
      return instanceId;
    },
    [
      agentOpMapByScope,
      scopeKey,
      createInstance,
      instancesByScope,
      setAgentOpMapByScope,
    ],
  );

  useEffect(() => {
    if (chatId == null) return;
    const ipc = IpcClient.getInstance();
    const unsubscribe = ipc.onTerminalOutput(chatId, (payload) => {
      if (payload.commandId.startsWith("user-")) return;
      const instanceId = getOrCreateAgentInstance(
        payload.commandId,
        payload.command,
      );
      setInstances((prev) =>
        upsertAgentOutputLines(
          prev,
          instanceId,
          payload.commandId,
          payload.command,
          payload.output ?? "",
          payload.status,
        ),
      );
    });
    return unsubscribe;
  }, [chatId, getOrCreateAgentInstance, setInstances]);

  useEffect(() => {
    const outputs = Array.from(terminalOutputs.values()).sort(
      (a, b) => a.startTime - b.startTime,
    );
    for (const out of outputs) {
      const key = `${out.operationId}:${out.status}:${out.output?.length ?? 0}`;
      if (seenOps.current.has(key)) continue;
      if (out.operationId.startsWith("user-")) continue;
      seenOps.current.add(key);
      if (out.status === "running" && !out.output?.trim()) continue;
      const instanceId = getOrCreateAgentInstance(out.operationId, out.command);
      setInstances((prev) =>
        upsertAgentOutputLines(
          prev,
          instanceId,
          out.operationId,
          out.command,
          out.output ?? "",
          out.status,
        ),
      );
    }
  }, [terminalOutputs, getOrCreateAgentInstance, setInstances]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeInstance?.lines]);

  const runUserCommand = useCallback(async () => {
    const command = input.trim();
    if (!command || running || !workspacePath || !activeInstance) return;
    if (activeInstance.owner !== "user") return;

    setInput("");
    setRunning(true);
    appendToInstance(activeInstance.id, [
      {
        id: `you-cmd-${Date.now()}`,
        prefix: "[You]",
        text: `$ ${command}`,
        kind: "prompt",
      },
    ]);

    try {
      const result = await IpcClient.getInstance().runTerminalCommand({
        command,
        cwd: workspacePath,
        chatId: chatId ?? 0,
        source: "user",
      });
      if (result.output?.trim()) {
        appendToInstance(activeInstance.id, [
          {
            id: `you-out-${Date.now()}`,
            prefix: "[You]",
            text: result.output,
            kind: "output",
          },
        ]);
      }
      appendToInstance(activeInstance.id, [
        {
          id: `you-st-${Date.now()}`,
          prefix: "[You]",
          text: result.timedOut
            ? `timed out (exit ${result.exitCode})`
            : `exit ${result.exitCode}`,
          kind: "status",
        },
      ]);
    } catch (err) {
      appendToInstance(activeInstance.id, [
        {
          id: `you-err-${Date.now()}`,
          prefix: "[You]",
          text: err instanceof Error ? err.message : String(err),
          kind: "status",
        },
      ]);
    } finally {
      setRunning(false);
    }
  }, [
    input,
    running,
    workspacePath,
    activeInstance,
    chatId,
    appendToInstance,
  ]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runUserCommand();
    }
  };

  const noWorkspace = !workspacePath;
  const userInstances = instances.filter((i) => i.owner === "user");
  const agentInstances = instances.filter((i) => i.owner === "agent");
  const logLines = activeInstance?.lines ?? [];

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 bg-zinc-900 shrink-0">
        <Terminal className="w-4 h-4 text-zinc-400" />
        <span className="text-sm text-zinc-300">Terminal</span>
        {running && (
          <span className="ml-auto flex items-center gap-1 text-xs text-green-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            Running
          </span>
        )}
      </div>

      <div className="shrink-0 border-b border-zinc-700 bg-zinc-900/80 px-2 py-1.5 space-y-1.5 max-h-[120px] overflow-y-auto">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide mr-1">
            You
          </span>
          {userInstances.map((inst) => (
            <button
              key={inst.id}
              type="button"
              onClick={() =>
                setActiveByScope((prev) => ({ ...prev, [scopeKey]: inst.id }))
              }
              className={cn(
                "group flex items-center gap-1 max-w-[140px] px-2 py-0.5 rounded text-[11px] font-mono truncate",
                activeInstance?.id === inst.id
                  ? "bg-amber-500/20 text-amber-200"
                  : "text-zinc-400 hover:bg-zinc-800",
              )}
            >
              <span className="truncate">{inst.label}</span>
              {userInstances.length > 1 && (
                <X
                  className="w-3 h-3 shrink-0 opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteInstance(inst.id);
                  }}
                />
              )}
            </button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-zinc-400"
            title="New shell"
            onClick={() => createInstance("user")}
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide mr-1">
            Agent
          </span>
          {agentInstances.map((inst) => (
            <button
              key={inst.id}
              type="button"
              onClick={() =>
                setActiveByScope((prev) => ({ ...prev, [scopeKey]: inst.id }))
              }
              className={cn(
                "group flex items-center gap-1 max-w-[180px] px-2 py-0.5 rounded text-[11px] font-mono truncate",
                activeInstance?.id === inst.id
                  ? "bg-blue-500/20 text-blue-200"
                  : "text-zinc-400 hover:bg-zinc-800",
              )}
            >
              <span className="truncate">{inst.label}</span>
              <X
                className="w-3 h-3 shrink-0 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteInstance(inst.id);
                }}
              />
            </button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-zinc-400"
            title="New agent terminal"
            onClick={() => createInstance("agent")}
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap min-h-0"
      >
        {logLines.length === 0 ? (
          <p className="text-zinc-500">
            Command output from you and the agent appears here. Output persists
            when you switch tabs until you start a new chat.
          </p>
        ) : (
          logLines.map((line) => (
            <div key={line.id} className="mb-1">
              <span
                className={
                  line.prefix === "[Agent]"
                    ? "text-blue-400/90 mr-2"
                    : "text-amber-400/90 mr-2"
                }
              >
                {line.prefix}
              </span>
              <span
                className={
                  line.kind === "prompt"
                    ? "text-zinc-100"
                    : line.kind === "status"
                      ? "text-zinc-500"
                      : ""
                }
              >
                {line.text}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-zinc-700 bg-zinc-900 p-2 space-y-2">
        <div className="text-[10px] text-zinc-500 font-mono truncate px-1">
          {cwdLabel}
          {activeInstance?.owner === "agent" ? (
            <span className="text-blue-400/80 ml-2">(viewing agent — read-only)</span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={
              running ||
              noWorkspace ||
              !activeInstance ||
              activeInstance.owner !== "user"
            }
            placeholder={
              noWorkspace
                ? "Open a workspace to run commands"
                : activeInstance?.owner === "agent"
                  ? "Select a Shell tab to run commands"
                  : "Enter command..."
            }
            className="font-mono text-xs h-8 bg-zinc-800 border-zinc-600 text-zinc-100"
          />
          <Button
            size="sm"
            onClick={() => void runUserCommand()}
            disabled={
              running ||
              !input.trim() ||
              noWorkspace ||
              !activeInstance ||
              activeInstance.owner !== "user"
            }
            className="h-8 shrink-0"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : "Run"}
          </Button>
        </div>
      </div>
    </div>
  );
}
