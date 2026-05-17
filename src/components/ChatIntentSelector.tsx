/**
 * Work mode dropdown (Ask / Plan / Build / Debug / Review).
 */

import { useEffect, useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { cn } from "@/lib/utils";
import { MessageCircle, ListTodo, Hammer, Bug, ShieldCheck } from "lucide-react";
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
import {
  labelForWorkMode,
  settingsPatchForWorkMode,
} from "@/lib/work-mode";

const HAS_SEEN_INTENT_KEY = "atlarix.hasSeenIntentExplanation";

const WORK_MODES: { value: WorkMode; icon: typeof MessageCircle; desc: string }[] = [
  {
    value: "ask",
    icon: MessageCircle,
    desc: "Read-only exploration—no plan file writes. Use Plan for roadmaps, then Build to implement.",
  },
  {
    value: "plan",
    icon: ListTodo,
    desc: "Plan file only (.atlarix/ATLARIX_PLAN.md + ATLARIX.md). Switch to Build after the plan is done.",
  },
  { value: "build", icon: Hammer, desc: "Full write/run tools for end-to-end implementation." },
  { value: "debug", icon: Bug, desc: "Investigation focus; read tools + diagnose_issue + run_command." },
  { value: "review", icon: ShieldCheck, desc: "Review and quality; Ask tools + review-style prompts." },
];

export function ChatIntentSelector() {
  const appId = useAtomValue(selectedAppIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const { settings, updateSettings } = useSettings();
  const [showFirstTime, setShowFirstTime] = useState(() => {
    if (typeof window === "undefined") return false;
    return !window.localStorage.getItem(HAS_SEEN_INTENT_KEY);
  });

  const effectivePermission =
    settings?.selectedChatMode === "agent"
      ? "build"
      : settings?.selectedChatMode ?? "ask";

  const workMode: WorkMode =
    settings?.workModePreference ??
    (effectivePermission === "ask" ? "ask" : "build");

  /** No workspace, or ephemeral/incognito chat (negative id): read-only chrome — Ask only. */
  const isReadOnlyChatChrome =
    !appId || (typeof selectedChatId === "number" && selectedChatId < 0);

  useEffect(() => {
    if (!isReadOnlyChatChrome) return;
    if (
      settings?.selectedChatMode !== "ask" ||
      settings?.workModePreference !== "ask" ||
      settings?.intentMode !== "ask"
    ) {
      updateSettings({
        selectedChatMode: "ask",
        intentMode: "ask", // clear any legacy Auto state
        workModePreference: "ask",
      });
    }
  }, [
    isReadOnlyChatChrome,
    appId,
    selectedChatId,
    settings?.selectedChatMode,
    settings?.workModePreference,
    updateSettings,
  ]);

  const noWorkspace = !appId;

  const setWorkMode = (mode: WorkMode) => {
    if (isReadOnlyChatChrome && mode !== "ask") {
      return;
    }
    updateSettings({
      ...settingsPatchForWorkMode(mode),
    });
  };
  const workIcon =
    WORK_MODES.find((w) => w.value === workMode)?.icon ?? MessageCircle;
  const WorkIcon = workIcon;

  const dismissFirstTime = () => {
    setShowFirstTime(false);
    try {
      window.localStorage.setItem(HAS_SEEN_INTENT_KEY, "1");
    } catch (_) {}
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
                {noWorkspace
                  ? "Open or create a workspace for Plan, Build, and other write modes."
                  : "This incognito chat is read-only. Open a normal workspace chat for Plan, Build, and Auto."}
              </TooltipContent>
            </Tooltip>
          ) : (
            <>
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
                      <SelectValue>
                        {labelForWorkMode(workMode)}
                      </SelectValue>
                    </MiniSelectTrigger>
                  </TooltipTrigger>
                  <TooltipContent>
                    {"Work mode: tool surface per mode. Open for Ask, Plan, Build, Debug, Review."}
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
                          <span className="text-xs text-muted-foreground font-normal">{desc}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </>
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
