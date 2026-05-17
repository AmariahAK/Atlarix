/**
 * Interactive terminal panel — shared output stream for agent and user commands.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { terminalOutputsAtom, type TerminalOutput } from "@/atoms/sourceAtoms";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { Terminal, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type LogLine = {
  id: string;
  prefix: "[Agent]" | "[You]";
  text: string;
  kind: "prompt" | "output" | "status";
};

function shortenPath(fullPath: string): string {
  const m = fullPath.match(/^\/Users\/[^/]+(.*)$/);
  if (m) return `~${m[1] || ""}`;
  const win = fullPath.match(/^[A-Za-z]:\\Users\\[^\\]+(.*)$/);
  if (win) return `~${win[1].replace(/\\/g, "/") || ""}`;
  return fullPath;
}

function outputToLines(
  prefix: "[Agent]" | "[You]",
  command: string,
  output: string,
  status: TerminalOutput["status"],
): LogLine[] {
  const lines: LogLine[] = [
    {
      id: `cmd-${Date.now()}-${Math.random()}`,
      prefix,
      text: `$ ${command}`,
      kind: "prompt",
    },
  ];
  if (output.trim()) {
    lines.push({
      id: `out-${Date.now()}-${Math.random()}`,
      prefix,
      text: output,
      kind: "output",
    });
  }
  if (status === "completed" || status === "error") {
    lines.push({
      id: `st-${Date.now()}-${Math.random()}`,
      prefix,
      text:
        status === "completed"
          ? `exit ${0}`
          : `failed`,
      kind: "status",
    });
  }
  return lines;
}

export function TerminalPanel() {
  const terminalOutputs = useAtomValue(terminalOutputsAtom);
  const chatId = useAtomValue(selectedChatIdAtom);
  const workspace = useAtomValue(selectedWorkspaceInfoAtom);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const seenOps = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const cwdLabel = useMemo(() => {
    const p = workspace?.path;
    if (!p) return "~ $";
    return `${shortenPath(p)} $`;
  }, [workspace?.path]);

  // Sync agent terminal-output map into chronological log
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
      setLogLines((prev) => {
        const withoutSame = prev.filter(
          (l) => l.kind !== "output" || !l.id.startsWith(out.operationId),
        );
        return [
          ...withoutSame,
          ...outputToLines("[Agent]", out.command, out.output ?? "", out.status),
        ];
      });
    }
  }, [terminalOutputs]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  const runUserCommand = useCallback(async () => {
    const command = input.trim();
    if (!command || running || chatId == null || chatId < 0) return;
    if (!workspace?.path) return;

    setInput("");
    setRunning(true);
    setLogLines((prev) => [
      ...prev,
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
        cwd: workspace.path,
        chatId,
        source: "user",
      });
      if (result.output?.trim()) {
        setLogLines((prev) => [
          ...prev,
          {
            id: `you-out-${Date.now()}`,
            prefix: "[You]",
            text: result.output,
            kind: "output",
          },
        ]);
      }
      setLogLines((prev) => [
        ...prev,
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
      setLogLines((prev) => [
        ...prev,
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
  }, [input, running, chatId, workspace?.path]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runUserCommand();
    }
  };

  const noWorkspace = !workspace?.path;

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

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap min-h-0"
      >
        {logLines.length === 0 ? (
          <p className="text-zinc-500">Command output from you and the agent appears here.</p>
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
        <div className="text-[10px] text-zinc-500 font-mono truncate px-1">{cwdLabel}</div>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={running || noWorkspace || chatId == null || chatId < 0}
            placeholder={
              noWorkspace
                ? "Open a workspace to run commands"
                : "Enter command..."
            }
            className="font-mono text-xs h-8 bg-zinc-800 border-zinc-600 text-zinc-100"
          />
          <Button
            size="sm"
            onClick={() => void runUserCommand()}
            disabled={running || !input.trim() || noWorkspace || chatId == null || chatId < 0}
            className="h-8 shrink-0"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : "Run"}
          </Button>
        </div>
      </div>
    </div>
  );
}
