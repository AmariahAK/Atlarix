/**
 * Full-screen Code page
 * Left: file tree, Center: single-file editor, Right: Chat | Errors | Terminal (same session as main)
 */

import { useState, useEffect, useMemo } from "react";
import { useSearch } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { selectedAppIdAtom, currentAppAtom } from "@/atoms/appAtoms";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import { browserErrorsAtom, terminalOutputsAtom, devServerUrlAtom } from "@/atoms/sourceAtoms";
import { WorkspaceFileTree } from "@/components/workspace/WorkspaceFileTree";
import { FileEditor } from "@/components/preview_panel/FileEditor";
import CodePreviewPanel from "@/components/preview_panel/CodePreviewPanel";
import { IpcClient } from "@/ipc/ipc_client";
import { MessageCircle, AlertTriangle, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLoadApp } from "@/hooks/useLoadApp";
import { useRightPanelContext } from "@/hooks/useRightPanelContext";

type CodePageTab = "chat" | "errors" | "terminal";

export default function CodePage() {
  const search = useSearch({ strict: false }) as { appId?: number | string };
  const appIdFromRoute = search?.appId != null ? Number(search.appId) : undefined;
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const currentApp = useAtomValue(currentAppAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);

  // Sync route appId to atom so useLoadApp runs
  useEffect(() => {
    if (appIdFromRoute != null && appIdFromRoute !== selectedAppId) {
      setSelectedAppId(appIdFromRoute);
    }
  }, [appIdFromRoute, selectedAppId, setSelectedAppId]);

  useLoadApp(selectedAppId);

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CodePageTab>("errors");

  const files = currentApp?.files ?? [];
  const appId = currentApp?.id ?? selectedAppId;

  const browserErrors = useAtomValue(browserErrorsAtom);
  const terminalOutputs = useAtomValue(terminalOutputsAtom);
  const devServerUrl = useAtomValue(devServerUrlAtom);
  const { context } = useRightPanelContext();

  // Panel data: prefer context from main layout, else build from atoms for Errors/Terminal
  const panelData = useMemo(() => {
    if (context.data?.errors !== undefined || context.data?.terminal !== undefined) {
      return context.data;
    }
    const latestTerminal = terminalOutputs.size > 0
      ? Array.from(terminalOutputs.values()).sort((a, b) => b.startTime - a.startTime)[0]
      : null;
    return {
      url: devServerUrl ?? undefined,
      errors: browserErrors,
      terminal: latestTerminal
        ? { output: (latestTerminal.output || "").split("\n"), running: latestTerminal.status === "running" }
        : undefined,
      appId: appId ?? undefined,
      workspacePath: currentApp?.path ? undefined : undefined,
    };
  }, [context.data, browserErrors, terminalOutputs, devServerUrl, appId, currentApp?.path]);

  return (
    <div className="flex h-full w-full">
      {/* Left: file tree (narrow to give editor more room; aligns with app sidebar when on /code) */}
      <div className="w-40 flex-shrink-0 border-r border-border flex flex-col bg-muted/20">
        <div className="px-2 py-2 text-xs font-medium text-muted-foreground border-b border-border">
          Files
        </div>
        <div className="flex-1 overflow-auto">
          <WorkspaceFileTree
            files={files}
            onFileClick={(path) => setSelectedFilePath(path)}
            maxHeight="100%"
          />
        </div>
      </div>

      {/* Center: editor */}
      <div className="flex-1 flex flex-col min-w-[8rem] bg-background">
        {selectedFilePath && appId ? (
          <FileEditor appId={appId} filePath={selectedFilePath} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Select a file from the tree
          </div>
        )}
      </div>

      {/* Right: Chat | Errors | Terminal */}
      <div className="w-72 flex-shrink min-w-32 border-l border-border flex flex-col bg-[#1e1e1e]">
        <div className="flex border-b border-zinc-800">
          {(
            [
              { id: "chat" as const, icon: MessageCircle, label: "Chat" },
              { id: "errors" as const, icon: AlertTriangle, label: "Errors" },
              { id: "terminal" as const, icon: Terminal, label: "Terminal" },
            ] as const
          ).map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
                activeTab === id
                  ? "bg-zinc-700 text-zinc-100 border-b-2 border-primary"
                  : "text-zinc-400 hover:text-zinc-300"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto">
          {activeTab === "chat" && (
            <CodePageChatTab chatId={activeChatId} />
          )}
          {(activeTab === "errors" || activeTab === "terminal") && (
            <CodePreviewPanel
              data={panelData}
              activeTab={activeTab}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CodePageChatTab({ chatId }: { chatId: number | null }) {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [loading, setLoading] = useState(!!chatId);

  useEffect(() => {
    if (!chatId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    IpcClient.getInstance()
      .getChat(chatId)
      .then((chat) => {
        setMessages(
          (chat.messages ?? []).map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }))
        );
      })
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, [chatId]);

  if (!chatId) {
    return (
      <div className="p-4 text-center text-sm text-zinc-500">
        No active chat. Start a conversation on the home page.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="p-4 text-center text-sm text-zinc-500">
        Loading…
      </div>
    );
  }
  return (
    <div className="p-3 space-y-3 overflow-auto">
      {messages.map((m, i) => (
        <div
          key={i}
          className={cn(
            "rounded-md px-3 py-2 text-sm",
            m.role === "user"
              ? "bg-primary/10 text-primary-foreground"
              : "bg-zinc-800 text-zinc-200"
          )}
        >
          <div className="font-medium text-xs text-zinc-400 mb-1">{m.role}</div>
          <div className="whitespace-pre-wrap break-words">{m.content}</div>
        </div>
      ))}
    </div>
  );
}
