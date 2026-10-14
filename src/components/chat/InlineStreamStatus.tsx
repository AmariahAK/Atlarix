import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  activeTurnScopeAtom,
  isStreamingForChatAtom,
  reconnectingByChatIdAtom,
  liveToolInputByChatIdAtom,
  toolIndicatorAtom,
  waitingOnCommandByChatIdAtom,
} from "@/atoms/chatAtoms";
import {
  activityStreamItemsAtom,
  aiPanelIntentAtom,
} from "@/atoms/sourceAtoms";
import {
  permissionQueueAtom,
  getOperationsByStatus,
} from "@/atoms/permissionQueueAtom";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { Archive, ChevronDown, ChevronUp, TimerIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { getToolActivityLabelWithArgs } from "@/lib/tool-activity-labels";
import { describePendingApproval } from "@/components/chat/PendingApprovalsBar";
import { useSettings } from "@/hooks/useSettings";
import type { WorkMode } from "@/lib/schemas";

/** "0:42" / "12:03" elapsed display. */
export function formatWaitElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** Turn older than this shows the subtle elapsed note (replaces the old banner). */
const STILL_WORKING_AFTER_MS = 60_000;
/** Silent reasoning longer than this shows a "still reasoning (Xs)" affordance so
 * a healthy-but-slow thinking phase doesn't look frozen (and users don't resend). */
const REASONING_STILL_AFTER_MS = 4_000;

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
  // Scoped to this chat so another chat's stream flush doesn't re-render this.
  const isStreamingThisChat = useAtomValue(
    isStreamingForChatAtom(chatId ?? -1),
  );
  const activityItems = useAtomValue(activityStreamItemsAtom);
  const waitingByChatId = useAtomValue(waitingOnCommandByChatIdAtom);
  const reconnectingByChatId = useAtomValue(reconnectingByChatIdAtom);
  const liveToolInputByChatId = useAtomValue(liveToolInputByChatIdAtom);
  const permissionQueue = useAtomValue(permissionQueueAtom);
  const activeTurnScope = useAtomValue(activeTurnScopeAtom);
  const setPanelIntent = useSetAtom(aiPanelIntentAtom);
  const workMode = settings?.workModePreference;
  // Live terminal output auto-streams while a command runs (like the edit_file
  // live preview); the user can still collapse it.
  const [outputExpanded, setOutputExpanded] = useState(true);

  const isTargetStreaming = chatId != null && isStreamingThisChat === true;
  const waiting = chatId != null ? waitingByChatId.get(chatId) : undefined;

  // 1s ticker for the elapsed displays (waiting chip / still-working note).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !isTargetStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, isTargetStreaming]);
  /**
   * Compaction, mid-turn — the pause the UI never explained.
   *
   * The agent stops for several seconds to summarise its own context, and the
   * status line said nothing, so it read as a hang.
   *
   * READ FROM THE `background` EVENT, NOT THE `compaction` ONE. The main process
   * emits both for the same moment, and `chat-activity-normalize.ts` drops the
   * `compaction` type ON PURPOSE — admitting it would put two rows in the atom
   * for one event, and `compress-context-persistence.test.ts` pins the drop as
   * the documented contract. So this matches the same shape
   * `useCompactionTokenVisuals` already does: a background row whose label reads
   * as compaction. One channel, already working, no new type.
   */
  const compaction = useMemo(() => {
    const rows = activityItems.filter(
      (i) =>
        i.type === "background" &&
        // An automation's wake line is a background row too, named by the user.
        !i.id?.startsWith("wake-") &&
        /summariz|compress|compact/i.test(i.label ?? "") &&
        (chatId == null || i.chatId === chatId),
    );
    const last = rows[rows.length - 1];
    if (!last) return undefined;
    // A finished compaction is only interesting for a moment. After that the
    // ordinary status line is more useful than a stale banner.
    if (last.status === "done" && now - (last.timestamp ?? 0) > 6000)
      return undefined;
    return last;
  }, [activityItems, chatId, now]);

  const autonomousOverride = useMemo(
    () => subagentsActiveForChat(activityItems, chatId ?? undefined),
    [activityItems, chatId],
  );

  // #5: timestamp of the current silent-reasoning phase (a reasoning_started not
  // yet followed by reasoning_complete), for the "still reasoning (Xs)" line.
  const reasoningStartedAt = useMemo(() => {
    if (chatId == null) return null;
    let startTs: number | null = null;
    for (const it of activityItems) {
      if (it.chatId != null && it.chatId !== chatId) continue;
      if (it.type === "reasoning_started") startTs = it.timestamp ?? startTs;
      else if (it.type === "reasoning_complete") startTs = null;
    }
    return startTs;
  }, [activityItems, chatId]);

  // Stream phase (thinking label / done) → shared indicator atom.
  // Tool start/end IPC is handled in useStreamChat only (avoids double count).
  useEffect(() => {
    if (!active) return;
    const unsub = IpcClient.getInstance().onStreamPhase(
      ({ chatId: evChatId, phase, label }) => {
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
      },
    );
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
  // 2. "Reconnecting…" ONLY when the backend is genuinely retrying a dropped/
  //    stalled round (not from passive silence — slow thinking isn't a drop)
  // 3. "Still working (Ns)" for long turns
  // 4. the live tool/phase label
  const reconnecting =
    !waiting && chatId != null && reconnectingByChatId.get(chatId) === true;
  // A pending permission card means the turn is blocked ON THE USER (not the
  // model computing) — say so plainly instead of "still working".
  const hasPendingApproval =
    getOperationsByStatus(permissionQueue, "pending").length > 0;
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
  const reasoningElapsedMs = reasoningStartedAt ? now - reasoningStartedAt : 0;
  const inSilentReasoning =
    reasoningStartedAt != null &&
    state.count === 0 &&
    reasoningElapsedMs > REASONING_STILL_AFTER_MS;
  if (reconnecting) {
    displayLine = "Reconnecting…";
  } else if (hasPendingApproval) {
    displayLine =
      turnAgeMs > STILL_WORKING_AFTER_MS
        ? `Waiting for your approval (${formatWaitElapsed(turnAgeMs)})`
        : "Waiting for your approval";
  } else if (inSilentReasoning) {
    // Long silent thinking phase — reassure it's progressing, not frozen.
    displayLine = `Still reasoning (${formatWaitElapsed(reasoningElapsedMs)})`;
  } else if (!waiting && turnAgeMs > STILL_WORKING_AFTER_MS) {
    displayLine = `${displayLine} · still working (${formatWaitElapsed(turnAgeMs)})`;
  }

  const showLiveOutput = state.count > 0 && state.liveOutputLines.length > 0;
  const liveText = (
    state.liveErrorLines.length > 0
      ? state.liveErrorLines
      : state.liveOutputLines
  ).join("\n");

  // Live partial-args preview: the file content building up while the model
  // streams an edit_file write/replace, before the approval card opens.
  const live = chatId != null ? liveToolInputByChatId.get(chatId) : undefined;
  const liveWritePreview =
    live && live.content
      ? (() => {
          const lines = live.content.split("\n");
          const tail = lines.slice(-12);
          return {
            path: live.path,
            text: tail.join("\n"),
            more: lines.length - tail.length,
          };
        })()
      : null;

  // A turn blocked on YOUR approval gets the same amber timer pill a blocked
  // command gets, and for the same reason: the label alone was not enough.
  //
  // It already said "Waiting for your approval" below — but wrapped in the pulsing
  // thinking compass, with no icon and an elapsed borrowed from the whole turn. It
  // read as work in progress. Observed cost: a folder-grant card went unnoticed for
  // ten minutes while the turn looked busy. Same shape as the command wait, so the
  // two are learnable as one thing.
  if (!waiting && hasPendingApproval) {
    const pending = getOperationsByStatus(permissionQueue, "pending");
    return (
      <div className="mt-1.5 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => {
            const el = document.querySelector(
              `[data-permission-approvals="${chatId}"]`,
            );
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
          className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 hover:bg-muted/70 transition-colors"
          title="Jump to the approval waiting for you"
        >
          <TimerIcon className="h-3 w-3 text-amber-600 dark:text-amber-500" />
          <span className="font-medium">
            Waiting for you
            {turnAgeMs > 0 ? ` · ${formatWaitElapsed(turnAgeMs)}` : ""}
          </span>
          <span className="opacity-70">
            {pending.length === 1
              ? describePendingApproval(pending[0])
              : `${pending.length} approvals`}
          </span>
        </button>
      </div>
    );
  }

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
              context: {
                commandId: waiting.commandId,
                chatId: chatId ?? undefined,
              },
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
            if (chatId != null)
              IpcClient.getInstance().cancelChatStream(chatId);
          }}
          className="ml-1.5 align-middle text-[10px] underline-offset-2 hover:underline hover:text-foreground"
          title="Stop the turn (the running command continues to its own timeout)"
        >
          stop
        </button>
      </div>
    );
  }

  // ORDER MATTERS, and this is the right slot. It comes AFTER reconnecting and
  // after a pending approval — both of those either need the user or mean the
  // turn is in trouble, and compaction means the opposite (it is working) — and
  // BEFORE the ordinary status line, which is the thing it has to replace.
  if (compaction) {
    const running = compaction.status === "running";
    return (
      <div className="mt-1.5 text-xs text-muted-foreground">
        <div
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1"
          // Announced, because it explains a pause the user is already noticing.
          role="status"
          aria-live="polite"
          title={compaction.detail ?? undefined}
        >
          <Archive
            className={cn(
              "h-3 w-3 text-sky-600 dark:text-sky-400",
              // The pulse IS the message while it runs: something is happening
              // and the turn has not stalled. A finished pill sits still.
              running && "animate-pulse",
            )}
          />
          <span className={cn("font-medium", running && "animate-pulse")}>
            {running ? "Compressing context…" : "Context compressed"}
          </span>
          {compaction.detail ? (
            <span className="text-[10px] opacity-70">{compaction.detail}</span>
          ) : null}
        </div>
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
      {liveWritePreview && (
        <div className="mt-1">
          {liveWritePreview.path ? (
            <div className="px-1 text-[10px] font-mono text-foreground/70 truncate">
              {liveWritePreview.path}
            </div>
          ) : null}
          <pre className="mt-0.5 px-2 py-1.5 max-h-40 overflow-auto text-[10px] font-mono bg-[var(--diff-add-bg,theme(colors.emerald.500/10))] border border-border rounded whitespace-pre-wrap break-words">
            {liveWritePreview.more > 0
              ? `… (+${liveWritePreview.more} lines above)\n`
              : ""}
            {liveWritePreview.text}
          </pre>
        </div>
      )}
    </div>
  );
}
