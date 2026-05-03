/**
 * Wire AgentBus to IPC: forward agent messages to renderer as chat:activity for Activity Stream.
 */

import { BrowserWindow } from "electron";
import { subscribeAgentBus, type AgentMessage } from "./agent-bus";

function sendToAllWindows(channel: string, payload: unknown) {
  const wins = BrowserWindow.getAllWindows();
  wins.forEach((win) => {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send(channel, payload);
    }
  });
}

export function wireAgentBusToIpc(): () => void {
  return subscribeAgentBus((msg: AgentMessage) => {
    // Internal orchestration — do not surface in user-facing activity stream.
    if (msg.from === "main" && msg.type === "task_assign") return;

    sendToAllWindows("chat:activity", {
      id: msg.id,
      type: "agent_message",
      label: `${msg.from} → ${msg.to}: ${msg.type}`,
      status: "done",
      timestamp: msg.timestamp,
      fromAgent: msg.from,
      toAgent: msg.to,
      threadId: msg.threadId,
      chatId: msg.chatId,
      agentMessageType: msg.type,
      modelId: msg.modelId,
      responseMs: msg.responseMs,
    });
  });
}
