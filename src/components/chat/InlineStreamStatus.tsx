import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { isStreamingByIdAtom, toolIndicatorAtom } from "@/atoms/chatAtoms";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { ChevronDown, ChevronUp } from "lucide-react";
import { getToolActivityLabelWithArgs } from "@/lib/tool-activity-labels";
import { useSettings } from "@/hooks/useSettings";
import type { WorkMode } from "@/lib/schemas";

/** Idle status text when no tool is active yet. */
export function idleLabelForWorkMode(mode: WorkMode | undefined): string {
  switch (mode) {
    case "ask":
      return "Exploring…";
    case "plan":
      return "Planning…";
    case "build":
      return "Building…";
    case "debug":
      return "Fixing…";
    case "review":
      return "Reviewing…";
    default:
      return "Thinking…";
  }
}

function autonomousBusActiveForChat(
  items: ActivityStreamItem[],
  chatId: number | null | undefined,
): boolean {
  if (chatId == null) return false;
  const scoped = items.filter((i) => i.chatId == null || i.chatId === chatId);
  if (scoped.some((i) => i.type === "delegation_start" && i.status === "active")) {
    return true;
  }
  const agentMsgs = scoped.filter((i) => i.type === "agent_message");
  return agentMsgs.length >= 2;
}

/**
 * Inline streaming indicator under the CURRENT assistant response only:
 * a small compass that loops while working, settling into a stagnant "A"
 * when the turn completes, plus a one-line human-readable status while live.
 */
export function InlineStreamStatus({
  chatId,
  active,
}: {
  chatId: number | null | undefined;
  /** True while this message's stream is live; false renders the settled "A". */
  active: boolean;
}) {
  const state = useAtomValue(toolIndicatorAtom);
  const setState = useSetAtom(toolIndicatorAtom);
  const { settings } = useSettings();
  const streamingById = useAtomValue(isStreamingByIdAtom);
  const activityItems = useAtomValue(activityStreamItemsAtom);
  const workMode = settings?.workModePreference;
  const [outputExpanded, setOutputExpanded] = useState(false);

  const isTargetStreaming =
    chatId != null && streamingById.get(chatId) === true;

  const autonomousOverride = useMemo(
    () => autonomousBusActiveForChat(activityItems, chatId ?? undefined),
    [activityItems, chatId],
  );

  // Stream phase (thinking label / done) → shared indicator atom.
  // Tool start/end IPC is handled in useStreamChat only (avoids double count).
  useEffect(() => {
    if (!active) return;
    const unsub = IpcClient.getInstance().onStreamPhase(({ chatId: evChatId, phase, label }) => {
      setState((prev) => {
        if (phase === "done") {
          if (prev.activeChatId !== evChatId) return prev;
          return {
            ...prev,
            active: false,
            toolName: null,
            toolId: null,
            toolArgs: null,
            count: 0,
            phaseLabel: null,
            liveOutputLines: [],
            liveErrorLines: [],
            liveProgressLines: [],
          };
        }
        if (phase === "thinking") {
          return {
            ...prev,
            phaseLabel: label.trim() || "Thinking…",
            activeChatId: evChatId,
          };
        }
        if (phase === "responding") {
          if (prev.activeChatId !== evChatId) return prev;
          return { ...prev, phaseLabel: null };
        }
        return prev;
      });
    });
    return unsub;
  }, [setState, active]);

  // Completed turn: stagnant "A", no label.
  if (!active) {
    return (
      <div className="mt-1.5 flex items-center" aria-hidden>
        <AtlarixAnimation size="inline" phase="done" bare />
      </div>
    );
  }

  const showStatus =
    chatId != null &&
    isTargetStreaming &&
    (state.activeChatId === chatId || state.activeChatId === null);

  if (!showStatus) {
    return (
      <div className="mt-1.5 flex items-center">
        <AtlarixAnimation size="inline" phase="thinking" bare />
      </div>
    );
  }

  let displayLine = state.phaseLabel?.trim() || idleLabelForWorkMode(workMode);
  if (autonomousOverride) {
    displayLine = "Agents working…";
  } else if (state.count > 0 && (state.toolId || state.toolName)) {
    displayLine = getToolActivityLabelWithArgs(
      (state.toolId ?? state.toolName ?? "").trim(),
      state.toolArgs,
    );
  }

  const showLiveOutput =
    state.count > 0 && state.liveOutputLines.length > 0;
  const liveText = (
    state.liveErrorLines.length > 0 ? state.liveErrorLines : state.liveOutputLines
  ).join("\n");

  return (
    <div className="mt-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <AtlarixAnimation size="inline" phase="thinking" bare />
        <span className="font-medium animate-pulse">{displayLine}</span>
        {showLiveOutput && (
          <button
            type="button"
            onClick={() => setOutputExpanded((e) => !e)}
            className="flex items-center gap-1 text-[10px] hover:text-foreground"
          >
            {outputExpanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {outputExpanded ? "Hide output" : "Show output"}
          </button>
        )}
      </div>
      {showLiveOutput && outputExpanded && (
        <pre className="mt-1 px-2 py-1.5 max-h-40 overflow-auto text-[10px] font-mono bg-background/50 border border-border rounded whitespace-pre-wrap break-words">
          {liveText || "(no output yet)"}
        </pre>
      )}
    </div>
  );
}
