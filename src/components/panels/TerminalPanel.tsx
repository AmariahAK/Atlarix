/**
 * Interactive terminal panel — unified tab strip (user + agent instances).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { terminalOutputsAtom, type TerminalOutput } from "@/atoms/sourceAtoms";
import { attachmentsAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import {
  currentAppAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import {
  activeTerminalInstanceByScopeAtom,
  terminalAgentOpMapByScopeAtom,
  terminalInstancesByScopeAtom,
  terminalScopeKey,
  type TerminalInstance,
  type TerminalLine,
} from "@/atoms/terminalInstancesAtoms";
import {
  agentTabStripLabel,
  defaultAgentInstanceLabel,
  defaultUserInstanceLabel,
  userTabLabelFromInstance,
} from "@/lib/terminal-instances";
import { IpcClient } from "@/ipc/ipc_client";
import { Terminal, MessageSquarePlus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildTerminalPasteAttachment,
  buildTerminalPasteFromSelection,
  capTerminalLines,
  commandBlockRangeAt,
  commandBlockRanges,
  upsertTerminalAttachment,
  writeTerminalClipboard,
} from "@/lib/chat/terminal-line-buffer";
import { toast } from "sonner";
import { XtermView, disposeXtermInstance } from "./XtermView";
import { useSettings } from "@/hooks/useSettings";

function mergeLines(prev: TerminalLine[], add: TerminalLine[]): TerminalLine[] {
  return capTerminalLines([...prev, ...add]);
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
    return { ...inst, lines: capTerminalLines(lines) };
  });
}

export function TerminalPanel() {
  const terminalOutputs = useAtomValue(terminalOutputsAtom);
  const chatId = useAtomValue(selectedChatIdAtom);
  const workspace = useAtomValue(selectedWorkspaceInfoAtom);
  const currentApp = useAtomValue(currentAppAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);

  const scopeKey = terminalScopeKey(chatId, selectedAppId ?? currentApp?.id);
  const appId = selectedAppId ?? currentApp?.id ?? null;

  const [instancesByScope, setInstancesByScope] = useAtom(
    terminalInstancesByScopeAtom,
  );
  const [activeByScope, setActiveByScope] = useAtom(
    activeTerminalInstanceByScopeAtom,
  );
  const [agentOpMapByScope, setAgentOpMapByScope] = useAtom(
    terminalAgentOpMapByScopeAtom,
  );
  const setAttachments = useSetAtom(attachmentsAtom);

  const instances = instancesByScope[scopeKey] ?? [];
  const activeId = activeByScope[scopeKey];
  const activeInstance =
    instances.find((i) => i.id === activeId) ?? instances[0];

  const { settings } = useSettings();
  // v10 interactive PTY shells for user tabs; v10.1: the legacy single-command
  // input is gone — the kill-switch hard-disables user shells instead.
  const ptyEnabled = settings?.enablePtyTerminal !== false;
  // Live cwd per instance from shell OSC sequences (tab labels).
  const [cwdByInstance, setCwdByInstance] = useState<Record<string, string>>({});
  const seenOps = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const skipSyncRef = useRef(false);

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

  // v10.1: live cwd from OSC 7 / 1337 → tab labels.
  useEffect(() => {
    const unsub = IpcClient.getInstance().onPtyCwd(({ instanceId, cwd }) => {
      setCwdByInstance((prev) =>
        prev[instanceId] === cwd ? prev : { ...prev, [instanceId]: cwd },
      );
    });
    return unsub;
  }, []);

  const agentInstances = useMemo(
    () => instances.filter((i) => i.owner === "agent"),
    [instances],
  );

  const applyScopeFromMain = useCallback(
    (state: {
      instances: TerminalInstance[];
      activeInstanceId: string | null;
      agentOpMap: Record<string, string>;
    }) => {
      skipSyncRef.current = true;
      setInstancesByScope((prev) => ({ ...prev, [scopeKey]: state.instances }));
      setActiveByScope((prev) => ({
        ...prev,
        [scopeKey]: state.activeInstanceId ?? "",
      }));
      setAgentOpMapByScope((prev) => ({
        ...prev,
        [scopeKey]: state.agentOpMap,
      }));
      requestAnimationFrame(() => {
        skipSyncRef.current = false;
      });
    },
    [scopeKey, setInstancesByScope, setActiveByScope, setAgentOpMapByScope],
  );

  const syncScopeToMain = useCallback(() => {
    if (skipSyncRef.current) return;
    void IpcClient.getInstance()
      .syncTerminalScopeState({
        chatId,
        appId,
        state: {
          instances: instancesByScope[scopeKey] ?? [],
          activeInstanceId: activeByScope[scopeKey] ?? null,
          agentOpMap: agentOpMapByScope[scopeKey] ?? {},
        },
      })
      .catch(() => {});
  }, [
    chatId,
    appId,
    scopeKey,
    instancesByScope,
    activeByScope,
    agentOpMapByScope,
  ]);

  useEffect(() => {
    let cancelled = false;
    void IpcClient.getInstance()
      .getTerminalScopeState({ chatId, appId })
      .then(({ state }) => {
        if (cancelled) return;
        const local = instancesByScope[scopeKey] ?? [];
        if (local.length > 0 && state.instances.length === 0) {
          syncScopeToMain();
          return;
        }
        if (state.instances.length > 0) {
          applyScopeFromMain(state);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Hydrate once per scope; local-first when main is empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, chatId, appId]);

  useEffect(() => {
    const ipc = IpcClient.getInstance();
    const unsubUpdated = ipc.onTerminalInstancesUpdated(({ scopeKey: sk }) => {
      if (sk !== scopeKey) return;
      void ipc.getTerminalScopeState({ chatId, appId }).then(({ state }) => {
        applyScopeFromMain(state);
      });
    });
    const unsubCleared = ipc.onTerminalInstancesCleared(() => {
      skipSyncRef.current = true;
      setInstancesByScope({});
      setActiveByScope({});
      setAgentOpMapByScope({});
      requestAnimationFrame(() => {
        skipSyncRef.current = false;
      });
    });
    return () => {
      unsubUpdated();
      unsubCleared();
    };
  }, [
    scopeKey,
    chatId,
    appId,
    applyScopeFromMain,
    setInstancesByScope,
    setActiveByScope,
    setAgentOpMapByScope,
  ]);

  useEffect(() => {
    syncScopeToMain();
  }, [instancesByScope, activeByScope, agentOpMapByScope, syncScopeToMain]);

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
        const map = { ...prev[scopeKey] };
        for (const [op, inst] of Object.entries(map)) {
          if (inst === instanceId) delete map[op];
        }
        return { ...prev, [scopeKey]: map };
      });
      // v10: closing a user tab tears down its interactive shell (main kills the PTY).
      disposeXtermInstance(instanceId);
      void IpcClient.getInstance()
        .closeTerminalInstance({ chatId, appId, instanceId })
        .catch(() => {});
    },
    [
      instancesByScope,
      scopeKey,
      activeByScope,
      chatId,
      appId,
      setInstancesByScope,
      setActiveByScope,
      setAgentOpMapByScope,
    ],
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
          [scopeKey]: { ...prev[scopeKey], [operationId]: instanceId! },
        }));
        void IpcClient.getInstance()
          .openTerminalInstance({
            chatId,
            appId,
            owner: "agent",
            commandHint: command,
            operationId,
          })
          .catch(() => {});
      }
      return instanceId;
    },
    [
      agentOpMapByScope,
      scopeKey,
      createInstance,
      instancesByScope,
      setAgentOpMapByScope,
      chatId,
      appId,
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

  const tabLabel = (inst: TerminalInstance) => {
    if (inst.owner === "agent") {
      return agentTabStripLabel(inst, agentInstances);
    }
    // v10.1: live cwd from the shell wins; falls back to workspace path.
    return userTabLabelFromInstance(inst, cwdByInstance[inst.id] ?? workspacePath);
  };

  const tabTitle = (inst: TerminalInstance) =>
    inst.owner === "agent"
      ? inst.label
      : userTabLabelFromInstance(inst, cwdByInstance[inst.id] ?? workspacePath);

  const noWorkspace = !workspacePath;
  const logLines = activeInstance?.lines ?? [];

  // v10: user tabs get a real interactive shell (xterm + node-pty); agent tabs
  // stay on the read-only line list (their output is captured via run_command).
  const activeIsPtyShell =
    ptyEnabled && !noWorkspace && activeInstance?.owner === "user";

  const addCommandBlockToChat = useCallback(
    (promptIndex: number) => {
      if (!activeInstance) return;
      const { start, end, slice } = commandBlockRangeAt(
        activeInstance.lines,
        promptIndex,
      );
      const att = buildTerminalPasteAttachment({
        lines: slice,
        instanceLabel: activeInstance.label,
        owner: activeInstance.owner,
        lineStart: start,
        lineEnd: end,
      });
      setAttachments((prev) => upsertTerminalAttachment(prev, att));
      toast.success("Added to chat");
    },
    [activeInstance, setAttachments],
  );

  const handleLogCopy = useCallback(
    (e: React.ClipboardEvent) => {
      if (!activeInstance) return;
      const selected = window.getSelection()?.toString();
      if (!selected?.trim()) return;
      e.preventDefault();
      const att = buildTerminalPasteFromSelection({
        allLines: activeInstance.lines,
        selectedText: selected,
        instanceLabel: activeInstance.label,
        owner: activeInstance.owner,
      });
      const { terminalPaste } = att;
      if (!terminalPaste) return;
      const visible =
        terminalPaste.displayContent ?? terminalPaste.content;
      writeTerminalClipboard({
        content: visible,
        instanceLabel: terminalPaste.instanceLabel,
        owner: terminalPaste.owner,
        lineStart: terminalPaste.lineStart,
        lineEnd: terminalPaste.lineEnd,
      });
      toast.message("Copied — paste into chat to attach");
    },
    [activeInstance],
  );

  const commandBlocks = useMemo(
    () => commandBlockRanges(logLines),
    [logLines],
  );

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 bg-zinc-900 shrink-0">
        <Terminal className="w-4 h-4 text-zinc-400" />
        <span className="text-sm text-zinc-300">Terminal</span>
      </div>

      <div className="shrink-0 border-b border-zinc-700 bg-zinc-900/80 px-2 py-1.5 flex items-center gap-1 flex-wrap max-h-[88px] overflow-y-auto">
        {instances.map((inst) => (
          <button
            key={inst.id}
            type="button"
            title={tabTitle(inst)}
            onClick={() =>
              setActiveByScope((prev) => ({ ...prev, [scopeKey]: inst.id }))
            }
            className={cn(
              "group flex items-center gap-1 max-w-[160px] px-2 py-0.5 rounded text-[11px] font-mono truncate",
              activeInstance?.id === inst.id
                ? inst.owner === "agent"
                  ? "bg-blue-500/20 text-blue-200"
                  : "bg-amber-500/20 text-amber-200"
                : "text-zinc-400 hover:bg-zinc-800",
            )}
          >
            <span className="truncate">{tabLabel(inst)}</span>
            {(inst.owner === "agent" || instances.filter((i) => i.owner === "user").length > 1) && (
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
          size="sm"
          className="h-6 px-2 text-zinc-400 text-[11px] gap-1"
          title="New terminal"
          onClick={() => createInstance("user")}
        >
          <Plus className="w-3.5 h-3.5" />
          New terminal
        </Button>
      </div>

      {activeInstance?.owner === "user" && !activeIsPtyShell ? (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6 text-center">
          <p className="text-xs text-zinc-500 max-w-sm">
            {noWorkspace
              ? "Open a workspace to use the terminal."
              : "The interactive terminal is disabled in Settings (enablePtyTerminal)."}
          </p>
        </div>
      ) : activeIsPtyShell && activeInstance && workspacePath ? (
        <div className="flex-1 min-h-0">
          <XtermView
            key={activeInstance.id}
            instanceId={activeInstance.id}
            cwd={workspacePath}
            scopeKey={scopeKey}
            active
          />
        </div>
      ) : (
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap min-h-0 select-text"
        onCopy={handleLogCopy}
      >
        {logLines.length === 0 ? (
          <p className="text-zinc-500 select-none">
            {activeInstance?.owner === "agent"
              ? "Output from the agent's commands appears here."
              : "Command output appears here."}
          </p>
        ) : (
          logLines.map((line, lineIndex) => {
            const block = commandBlocks.find((b) => b.promptIndex === lineIndex);
            return (
              <div
                key={line.id}
                className={cn(
                  "group mb-1 flex items-start gap-1",
                  block && "rounded-md -mx-1 px-1 hover:bg-zinc-800/60",
                )}
              >
                <div className="min-w-0 flex-1">
                  {line.kind === "prompt" ? (
                    <>
                      <span
                        className={
                          line.prefix === "[Agent]"
                            ? "text-blue-400/90 mr-2"
                            : "text-amber-400/90 mr-2"
                        }
                      >
                        {line.prefix}
                      </span>
                      <span className="text-zinc-100">{line.text}</span>
                    </>
                  ) : (
                    <span
                      className={
                        line.kind === "status"
                          ? "text-zinc-500"
                          : "text-zinc-300"
                      }
                    >
                      {line.text}
                    </span>
                  )}
                </div>
                {block ? (
                  <button
                    type="button"
                    title="Add this command to chat"
                    className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 rounded text-zinc-500 hover:text-emerald-400 transition-opacity"
                    onClick={() => addCommandBlockToChat(block.promptIndex)}
                  >
                    <MessageSquarePlus className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      )}

      {activeInstance?.owner === "agent" ? (
        <div className="shrink-0 border-t border-zinc-700 bg-zinc-900 px-3 py-1.5">
          <span className="text-[10px] text-blue-400/80 font-mono">
            Viewing agent output — read-only
          </span>
        </div>
      ) : null}
    </div>
  );
}
