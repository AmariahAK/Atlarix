import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  activeTurnScopeAtom,
  isStreamingByIdAtom,
  streamLastActivityAtByChatIdAtom,
  toolIndicatorAtom,
  waitingOnCommandByChatIdAtom,
} from "@/atoms/chatAtoms";
import { activityStreamItemsAtom, aiPanelIntentAtom } from "@/atoms/sourceAtoms";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { ChevronDown, ChevronUp, TimerIcon } from "lucide-react";
import { getToolActivityLabelWithArgs } from "@/lib/tool-activity-labels";
import { useSettings } from "@/hooks/useSettings";
import type { WorkMode } from "@/lib/schemas";

/** "0:42" / "12:03" elapsed display. */
export function formatWaitElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** No stream chunk for this long → "Reconnecting…" (clears on the next chunk). */
const RECONNECTING_AFTER_MS = 10_000;
/** Turn older than this shows the subtle elapsed note (replaces the old banner). */
const STILL_WORKING_AFTER_MS = 60_000;

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

/** True while one or more `task` sub-agents are running for this chat. */
function subagentsActiveForChat(
  items: ActivityStreamItem[],
  chatId: number | null | undefined,
): boolean {
  if (chatId == null) return false;
  return items.some(
    (i) =>
      (i.chatId == null || i.chatId === chatId) &&
      i.type === "subagent_start" &&
      i.status === "running",
  );
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
  const waitingByChatId = useAtomValue(waitingOnCommandByChatIdAtom);
  const lastActivityByChatId = useAtomValue(streamLastActivityAtByChatIdAtom);
  const activeTurnScope = useAtomValue(activeTurnScopeAtom);
  const setPanelIntent = useSetAtom(aiPanelIntentAtom);
  const workMode = settings?.workModePreference;
  const [outputExpanded, setOutputExpanded] = useState(false);

  const isTargetStreaming =
    chatId != null && streamingById.get(chatId) === true;
  const waiting = chatId != null ? waitingByChatId.get(chatId) : undefined;

  // 1s ticker for the elapsed displays (waiting chip / still-working note).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !isTargetStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, isTargetStreaming]);

  const autonomousOverride = useMemo(
    () => subagentsActiveForChat(activityItems, chatId ?? undefined),
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

  // v13 prioritized one-liner (replaces the SlowStreamWarningBar banner):
  // 1. waiting on a command (persistent chip, click opens the terminal tab)
  // 2. "Reconnecting…" when the stream has gone quiet
  // 3. "Still working (Ns)" for long turns
  // 4. the live tool/phase label
  const lastActivityAt =
    chatId != null ? lastActivityByChatId.get(chatId) : undefined;
  const stalled =
    !waiting &&
    lastActivityAt != null &&
    now - lastActivityAt > RECONNECTING_AFTER_MS;
  const turnAgeMs =
    activeTurnScope?.chatId === chatId && activeTurnScope?.startedAt
      ? now - activeTurnScope.startedAt
      : 0;

  let displayLine = state.phaseLabel?.trim() || idleLabelForWorkMode(workMode);
  if (autonomousOverride) {
    displayLine = "Sub-agents working…";
  } else if (state.count > 0 && (state.toolId || state.toolName)) {
    displayLine = getToolActivityLabelWithArgs(
      (state.toolId ?? state.toolName ?? "").trim(),
      state.toolArgs,
    );
  }
  if (stalled) {
    displayLine = "Reconnecting…";
  } else if (!waiting && turnAgeMs > STILL_WORKING_AFTER_MS) {
    displayLine = `${displayLine} · still working (${formatWaitElapsed(turnAgeMs)})`;
  }

  const showLiveOutput =
    state.count > 0 && state.liveOutputLines.length > 0;
  const liveText = (
    state.liveErrorLines.length > 0 ? state.liveErrorLines : state.liveOutputLines
  ).join("\n");

  if (waiting) {
    // Persistent waiting chip — the model paused for a long-running command.
    // Clicking opens the right-panel Terminal tab on the agent's command.
    return (
      <div className="mt-1.5 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() =>
            setPanelIntent({
              intent: "show-terminal",
              context: { commandId: waiting.commandId, chatId: chatId ?? undefined },
              timestamp: Date.now(),
              source: "user",
            })
          }
          className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 hover:bg-muted/70 transition-colors"
          title={waiting.command ?? "Open the terminal to watch this command"}
        >
          <TimerIcon className="h-3 w-3 text-amber-600 dark:text-amber-500" />
          <span className="font-medium">
            Waiting on command · {formatWaitElapsed(now - waiting.startedAt)}
          </span>
          {waiting.command ? (
            <code className="max-w-[200px] truncate font-mono text-[10px] opacity-70">
              {waiting.command}
            </code>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => {
            if (chatId != null) IpcClient.getInstance().cancelChatStream(chatId);
          }}
          className="ml-1.5 align-middle text-[10px] underline-offset-2 hover:underline hover:text-foreground"
          title="Stop the turn (the running command continues to its own timeout)"
        >
          stop
        </button>
      </div>
    );
  }

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
