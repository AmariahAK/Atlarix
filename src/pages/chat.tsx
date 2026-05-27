import { useState, useRef, useEffect } from "react";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { ChatPanel } from "../components/ChatPanel";
import { PreviewPanel } from "../components/preview_panel/PreviewPanel";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import { useRightPanelUserPreference } from "@/hooks/useRightPanelUserPreference";
import { useChats } from "@/hooks/useChats";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
export default function ChatPage() {
  let { id: chatId } = useSearch({ from: "/chat" });
  const navigate = useNavigate();
  const [isPreviewOpen, setIsPreviewOpen] = useAtom(isPreviewOpenAtom);
  const { visible: rightPanelVisible, toggle: toggleRightPanel } = useRightPanelUserPreference();
  const [isResizing, setIsResizing] = useState(false);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const { chats, loading } = useChats(selectedAppId);

  useEffect(() => {
    if (!selectedAppId && !loading) {
      navigate({ to: "/", replace: true });
      return;
    }
    if (!chatId && chats.length && !loading && selectedAppId) {
      const wsChat = chats.find((c) => c.appId === selectedAppId) ?? chats[0];
      if (wsChat.appId) setSelectedAppId(wsChat.appId);
      navigate({ to: "/chat", search: { id: wsChat.id }, replace: true });
    }
  }, [chatId, chats, loading, navigate, selectedAppId, setSelectedAppId]);

  useEffect(() => {
    if (isPreviewOpen) {
      ref.current?.expand();
    } else {
      ref.current?.collapse();
    }
  }, [isPreviewOpen]);
  const ref = useRef<ImperativePanelHandle>(null);

  return (
    <PanelGroup autoSaveId="persistence" direction="horizontal">
      <Panel id="chat-panel" minSize={30}>
        <div className="h-full w-full min-h-0">
          <ChatPanel
            chatId={chatId}
            isPreviewOpen={rightPanelVisible}
            onTogglePreview={toggleRightPanel}
          />
        </div>
      </Panel>

      <>
        <PanelResizeHandle
          onDragging={(e) => setIsResizing(e)}
          className="w-1 bg-gray-200 hover:bg-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors cursor-col-resize"
        />
        <Panel
          collapsible
          ref={ref}
          id="preview-panel"
          minSize={20}
          className={cn(
            !isResizing && "transition-all duration-100 ease-in-out",
          )}
        >
          <PreviewPanel />
        </Panel>
      </>
    </PanelGroup>
  );
}
