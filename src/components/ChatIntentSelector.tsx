/**
 * Work mode dropdown (Ask / Plan / Build / Debug / Review) + separate Auto toggle.
 * Auto uses Blueprint + permission heuristics; manual modes map tools + tier (see work-mode.ts).
 */

import { useEffect, useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { cn } from "@/lib/utils";
import { MessageCircle, Sparkles, ListTodo, Hammer, Bug, ShieldCheck } from "lucide-react";
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
  { value: "build", icon: Hammer, desc: "Full write/run tools and Build-tier Blueprint context." },
  { value: "debug", icon: Bug, desc: "Investigation focus; Ask tools + Debug-tier Blueprint." },
  { value: "review", icon: ShieldCheck, desc: "Review and quality; Ask tools + review-style prompts." },
];

export function ChatIntentSelector() {
  const appId = useAtomValue(selectedAppIdAtom);
  const { settings, updateSettings } = useSettings();
  const [showFirstTime, setShowFirstTime] = useState(() => {
    if (typeof window === "undefined") return false;
    return !window.localStorage.getItem(HAS_SEEN_INTENT_KEY);
  });

  const effectivePermission =
    settings?.selectedChatMode === "agent"
      ? "build"
      : settings?.selectedChatMode ?? "ask";
  const intentMode = (settings?.intentMode ?? effectivePermission) as
    | "ask"
    | "build"
    | "auto";
  const isAuto = intentMode === "auto";

  const workMode: WorkMode =
    settings?.workModePreference ??
    (effectivePermission === "ask" ? "ask" : "build");

  useEffect(() => {
    if (!appId) {
      const intent = settings?.intentMode ?? settings?.selectedChatMode;
      if (
        settings?.selectedChatMode !== "ask" ||
        settings?.workModePreference !== "ask" ||
        intent !== "ask"
      ) {
        updateSettings({
          selectedChatMode: "ask",
          intentMode: "ask",
          workModePreference: "ask",
        });
      }
    }
  }, [
    appId,
    settings?.intentMode,
    settings?.selectedChatMode,
    settings?.workModePreference,
    updateSettings,
  ]);

  const noWorkspace = !appId;

  const setWorkMode = (mode: WorkMode) => {
    if (noWorkspace && mode !== "ask") {
      return;
    }
    updateSettings({
      ...settingsPatchForWorkMode(mode),
    });
  };

  const toggleAuto = () => {
    if (noWorkspace) {
      updateSettings({
        selectedChatMode: "ask",
        intentMode: "ask",
        workModePreference: "ask",
      });
      return;
    }
    if (isAuto) {
      const wm = settings?.workModePreference ?? "ask";
      updateSettings({
        ...settingsPatchForWorkMode(wm),
      });
    } else {
      updateSettings({
        intentMode: "auto",
        selectedChatMode: "ask",
      });
    }
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
                    isAuto
                      ? "opacity-70"
                      : "bg-background hover:bg-muted/50 focus:bg-muted/50",
                  )}
                  size="sm"
                >
                  <WorkIcon className="h-3.5 w-3.5 shrink-0" />
                  <SelectValue>
                    {labelForWorkMode(workMode)}
                    {isAuto ? " (Auto)" : ""}
                  </SelectValue>
                </MiniSelectTrigger>
              </TooltipTrigger>
              <TooltipContent>
                {isAuto
                  ? "Auto is on — heuristics pick Ask vs Build; open menu to pick a fixed work mode."
                  : "Work mode: tools + Blueprint tier. Open for Ask, Plan, Build, Debug, Review."}
              </TooltipContent>
            </Tooltip>
            <SelectContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
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

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => !noWorkspace && toggleAuto()}
                disabled={noWorkspace}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors h-7",
                  isAuto && "bg-background shadow-sm text-foreground",
                  !isAuto && !noWorkspace && "text-muted-foreground hover:text-foreground",
                  noWorkspace && "opacity-50 cursor-not-allowed text-muted-foreground",
                )}
                data-testid="chat-intent-auto"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Auto</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {noWorkspace
                ? "Select a workspace to enable Auto."
                : isAuto
                  ? "Click to leave Auto and return to the selected work mode."
                  : "AI chooses Ask vs Build from your message; Blueprint tier follows heuristics."}
            </TooltipContent>
          </Tooltip>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-80 text-sm">
        <p className="font-medium mb-1">Work mode + Auto</p>
        <p className="text-muted-foreground text-xs mb-3">
          Choose Ask, Plan, Build, Debug, or Review for fixed tools and Blueprint depth, or turn on
          Auto so the model switches Ask ↔ Build and tiers from context.
        </p>
        <Button size="sm" variant="secondary" onClick={dismissFirstTime}>
          Got it
        </Button>
      </PopoverContent>
    </Popover>
  );
}
