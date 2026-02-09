/**
 * Ask | Build | Auto intent selector. No emoji; Lucide icons only.
 * When no workspace, only Ask is selectable.
 * First-time: show dismissible explanation popover.
 */

import { useEffect, useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { cn } from "@/lib/utils";
import { MessageCircle, Hammer, Sparkles } from "lucide-react";
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

const HAS_SEEN_INTENT_KEY = "atlarix.hasSeenIntentExplanation";

type IntentMode = "ask" | "build" | "auto";

export function ChatIntentSelector() {
  const appId = useAtomValue(selectedAppIdAtom);
  const { settings, updateSettings } = useSettings();
  const [showFirstTime, setShowFirstTime] = useState(() => {
    if (typeof window === "undefined") return false;
    return !window.localStorage.getItem(HAS_SEEN_INTENT_KEY);
  });

  // When no workspace, force Ask so backend never receives build
  useEffect(() => {
    if (appId) return;
    const intent = settings?.intentMode ?? settings?.selectedChatMode;
    if (intent === "build" || intent === "auto") {
      updateSettings({ selectedChatMode: "ask", intentMode: "ask" });
    }
  }, [appId, settings?.intentMode, settings?.selectedChatMode]);

  const effectiveMode =
    (settings?.selectedChatMode === "agent" ? "build" : settings?.selectedChatMode) || "build";
  const intentMode = (settings?.intentMode ?? effectiveMode) as IntentMode;

  const setIntent = (mode: IntentMode) => {
    if (mode === "ask" || mode === "build") {
      updateSettings({
        selectedChatMode: mode,
        intentMode: mode,
      });
    } else {
      updateSettings({
        intentMode: "auto",
        selectedChatMode: "ask",
      });
    }
  };

  const noWorkspace = !appId;
  const options: { value: IntentMode; icon: typeof MessageCircle; label: string }[] = [
    { value: "ask", icon: MessageCircle, label: "Ask" },
    { value: "build", icon: Hammer, label: "Build" },
    { value: "auto", icon: Sparkles, label: "Auto" },
  ];

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
          className="inline-flex rounded-md border border-border bg-muted/30 p-0.5"
          data-testid="chat-intent-selector"
        >
          {options.map(({ value, icon: Icon, label }) => {
        const disabled = noWorkspace && (value === "build" || value === "auto");
        const active = intentMode === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => !disabled && setIntent(value)}
                disabled={disabled}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors",
                  active && "bg-background shadow-sm text-foreground",
                  !active && !disabled && "text-muted-foreground hover:text-foreground",
                  disabled && "opacity-50 cursor-not-allowed text-muted-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {value === "ask" && "Read-only; explanations and answers. Model can request Build."}
              {value === "build" && "Full access; can make code changes."}
              {value === "auto" && "AI chooses Ask or Build based on your request."}
              {disabled && " Select a workspace to enable."}
            </TooltipContent>
          </Tooltip>
        );
      })}
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-72 text-sm">
        <p className="font-medium mb-1">Ask · Build · Auto</p>
        <p className="text-muted-foreground text-xs mb-3">
          Ask: explanations only (read-only). Build: make code changes. Auto: AI chooses based on your request.
        </p>
        <Button size="sm" variant="secondary" onClick={dismissFirstTime}>
          Got it
        </Button>
      </PopoverContent>
    </Popover>
  );
}
