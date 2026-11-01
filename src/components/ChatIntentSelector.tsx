/**
 * Work mode dropdown (Explore / Plan / Build / Debug / Review).
 *
 * v14.8.9: sub-agents (explore/build + .atlarix/agents/*.md) are
 * `task`-tool targets the main agent spawns — NOT user-selectable chat modes — so
 * they are no longer shown here. The picker is the five work modes only.
 */

import { useState } from "react";
import { useAtomValue } from "jotai";
import {
  selectedChatIdAtom,
  isStreamingByIdAtom,
  turnWorkModeByChatIdAtom,
} from "@/atoms/chatAtoms";
import { resolveChatWorkspaceAppId } from "@/lib/chat-workspace-binding";
import { cn } from "@/lib/utils";
import {
  MessageCircle,
  ListTodo,
  Hammer,
  Bug,
  ShieldCheck,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  MiniSelectTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import type { WorkMode } from "@/lib/schemas";
import { labelForWorkMode } from "@/lib/work-mode";
import { useWorkModeSelection } from "@/hooks/useWorkModeSelection";

const HAS_SEEN_INTENT_KEY = "atlarix.hasSeenIntentExplanation";

const WORK_MODES: {
  value: WorkMode;
  icon: typeof MessageCircle;
  desc: string;
}[] = [
  {
    value: "ask",
    icon: MessageCircle,
    desc: "Read, search, run the project, and preview the app. No file edits, and changing the source with a command asks you first — use Plan for roadmaps, Build to implement.",
  },
  {
    value: "plan",
    icon: ListTodo,
    desc: "Plan the work with the plan tool (shown as a card). Can run commands to check its assumptions. No source edits — switch to Build to implement.",
  },
  {
    value: "build",
    icon: Hammer,
    desc: "Full write/run tools for end-to-end implementation.",
  },
  {
    value: "debug",
    icon: Bug,
    desc: "Hypothesis-first fixing: read + run_command, minimal edits to test a stated hypothesis.",
  },
  {
    value: "review",
    icon: ShieldCheck,
    desc: "Read-only review of what you name and everything it touches. No edits.",
  },
];

export function ChatIntentSelector() {
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const workspaceAppId = resolveChatWorkspaceAppId(selectedChatId);

  const [showFirstTime, setShowFirstTime] = useState(() => {
    if (typeof window === "undefined") return false;
    return !window.localStorage.getItem(HAS_SEEN_INTENT_KEY);
  });

  // The SESSION's mode wins when it has one; otherwise the global preference, which
  // is what every session written before the column existed still uses. Shared with
  // the composer footer (`resolveSelectedWorkMode`) so the two can never disagree —
  // they did, and that is what made a mid-turn switch look broken.
  // Shared with the Shift+Tab cycle (`useWorkModeSelection`) — one read, one write,
  // so the two controls cannot disagree about the mode or about what picking one does.
  const { workMode, setWorkMode: applyWorkMode } = useWorkModeSelection();

  /** Chat-only (no workspace): read-only chrome — Ask only. */
  const isReadOnlyChatChrome = workspaceAppId == null;

  // No longer forces the app's settings to Ask while such a chat is shown: that
  // changed the mode every OTHER chat started with. Its turns are sent as Ask
  // instead (useStreamChat), 15.11.1.

  const noWorkspace = workspaceAppId == null;

  const setWorkMode = (mode: WorkMode) => {
    if (isReadOnlyChatChrome && mode !== "ask") {
      return;
    }
    applyWorkMode(mode);
  };

  const WorkIcon =
    WORK_MODES.find((w) => w.value === workMode)?.icon ?? MessageCircle;

  // A live turn keeps the mode it was dispatched with — picking a new one here
  // applies to your NEXT message. Say so, rather than letting the picker and the
  // footer silently disagree about which mode is in force.
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const turnWorkModeByChatId = useAtomValue(turnWorkModeByChatIdAtom);
  const runningWorkMode =
    selectedChatId != null && isStreamingById.get(selectedChatId) === true
      ? turnWorkModeByChatId.get(selectedChatId)
      : undefined;
  const appliesNextTurn =
    runningWorkMode != null && runningWorkMode !== workMode;
  const triggerLabel = appliesNextTurn
    ? `${labelForWorkMode(workMode)} · next turn`
    : labelForWorkMode(workMode);

  const dismissFirstTime = () => {
    setShowFirstTime(false);
    try {
      window.localStorage.setItem(HAS_SEEN_INTENT_KEY, "1");
    } catch {}
  };

  return (
    <Popover
      open={showFirstTime}
      onOpenChange={(open) => {
        if (!open) dismissFirstTime();
      }}
    >
      <PopoverAnchor asChild>
        <div
          className={cn(
            "inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5",
          )}
          data-testid="chat-intent-selector"
        >
          {isReadOnlyChatChrome ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex h-7 min-w-[5.5rem] items-center gap-1 rounded-md border border-transparent bg-background/80 px-2 text-xs font-medium text-muted-foreground"
                  data-testid="chat-work-mode-readonly"
                >
                  <MessageCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>Ask · Read-only</span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                Open or add a workspace for Plan, Build, Debug, and Review.
              </TooltipContent>
            </Tooltip>
          ) : (
            <Select
              value={workMode}
              onValueChange={(v) => setWorkMode(v as WorkMode)}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <MiniSelectTrigger
                    data-testid="chat-work-mode-select"
                    className={cn(
                      "h-7 min-w-[5.5rem] px-2 py-0 text-xs font-medium shadow-none gap-1",
                      "bg-background hover:bg-muted/50 focus:bg-muted/50",
                    )}
                    size="sm"
                  >
                    <WorkIcon className="h-3.5 w-3.5 shrink-0" />
                    <SelectValue>{triggerLabel}</SelectValue>
                  </MiniSelectTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  {appliesNextTurn
                    ? `This turn is running in ${labelForWorkMode(runningWorkMode!)} and keeps that mode until it finishes. ${labelForWorkMode(workMode)} applies to your next message.`
                    : "Work mode: tool surface per mode. Open for Ask, Plan, Build, Debug, Review."}
                </TooltipContent>
              </Tooltip>
              <SelectContent
                align="start"
                side="top"
                position="popper"
                avoidCollisions
                collisionPadding={12}
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                {WORK_MODES.map(({ value, icon: Icon, desc }) => {
                  const disabled = noWorkspace && value !== "ask";
                  return (
                    <SelectItem key={value} value={value} disabled={disabled}>
                      <div className="flex flex-col items-start gap-0.5 py-0.5">
                        <span className="flex items-center gap-1.5 font-medium">
                          <Icon className="h-3.5 w-3.5" />
                          {labelForWorkMode(value)}
                        </span>
                        <span className="text-xs text-muted-foreground font-normal">
                          {desc}
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-80 text-sm">
        <p className="font-medium mb-1">
          {isReadOnlyChatChrome ? "Read-only chat" : "Work mode"}
        </p>
        <p className="text-muted-foreground text-xs mb-3">
          {isReadOnlyChatChrome
            ? "This chat uses Ask (read-only) only. Open a workspace and a saved chat to use Plan, Build, Debug, and Review."
            : "Choose Ask, Plan, Build, Debug, or Review for a fixed tool surface."}
        </p>
        <Button size="sm" variant="secondary" onClick={dismissFirstTime}>
          Got it
        </Button>
      </PopoverContent>
    </Popover>
  );
}
