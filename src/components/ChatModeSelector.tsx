import {
  MiniSelectTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSettings } from "@/hooks/useSettings";
import type { ChatMode, AgentMode } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { detectIsMac } from "@/hooks/useChatModeToggle";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import {
  MessageCircle,
  Crosshair,
  Bot,
  AlertTriangle,
} from "lucide-react";
import { TourHelpButton } from "@/components/tour/TourHelpButton";

export function ChatModeSelector() {
  const { settings, updateSettings } = useSettings();
  const appId = useAtomValue(selectedAppIdAtom);

  if (!appId) {
    return null;
  }

  const agentMode = (settings?.agentMode ?? "guided") as AgentMode;
  const permissionMode = (settings?.selectedChatMode === "agent"
    ? "build"
    : settings?.selectedChatMode) || "build";

  const handleAgentModeChange = (value: string) => {
    updateSettings({ agentMode: value as AgentMode });
  };

  const handlePermissionChange = (value: string) => {
    updateSettings({ selectedChatMode: value as ChatMode });
  };

  const isMac = detectIsMac();

  return (
    <div className="flex items-center gap-1" data-onboarding="ask-build-toggle" data-tour="tour-ask-build">
      {/* Mode: Direct / Guided / Autonomous */}
      <Select value={agentMode} onValueChange={handleAgentModeChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <MiniSelectTrigger
              data-testid="chat-agent-mode-selector"
              className={cn(
                "h-6 w-fit px-1.5 py-0 text-xs-sm font-medium shadow-none gap-0.5",
                "bg-background hover:bg-muted/50 focus:bg-muted/50"
              )}
              size="sm"
            >
              <span className="flex items-center gap-1">
                {agentMode === "direct" && <MessageCircle className="h-3 w-3" />}
                {agentMode === "guided" && <Crosshair className="h-3 w-3" />}
                {agentMode === "autonomous" && <Bot className="h-3 w-3" />}
                <SelectValue>
                  {agentMode === "direct"
                    ? "Direct"
                    : agentMode === "guided"
                      ? "Guided"
                      : "Autonomous"}
                </SelectValue>
              </span>
            </MiniSelectTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col">
              <span>Agent mode</span>
              <span className="text-xs text-muted-foreground">
                {isMac ? "⌘ + ." : "Ctrl + ."} to toggle
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
        <SelectContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
          <SelectItem value="direct">
            <div className="flex flex-col items-start gap-0.5">
              <span className="flex items-center gap-1.5 font-medium">
                <MessageCircle className="h-3.5 w-3" /> Direct
              </span>
              <span className="text-xs text-muted-foreground">
                No agents; direct conversation. (1x)
              </span>
            </div>
          </SelectItem>
          <SelectItem value="guided">
            <div className="flex flex-col items-start gap-0.5">
              <span className="flex items-center gap-1.5 font-medium">
                <Crosshair className="h-3.5 w-3" /> Guided
              </span>
              <span className="text-xs text-muted-foreground">
                AI picks specialists, flat delegation. (2–4x)
              </span>
            </div>
          </SelectItem>
          <SelectItem value="autonomous">
            <div className="flex flex-col items-start gap-0.5">
              <span className="flex items-center gap-1.5 font-medium">
                <Bot className="h-3.5 w-3" /> Autonomous
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Agents can spawn sub-agents. Higher token usage. (5–10x+)
              </span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>

      {/* Permission: Ask | Build */}
      <Select value={permissionMode} onValueChange={handlePermissionChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <MiniSelectTrigger
              data-testid="chat-permission-selector"
              className={cn(
                "h-6 w-fit px-1.5 py-0 text-xs-sm font-medium shadow-none gap-0.5",
                permissionMode === "build"
                  ? "bg-background hover:bg-muted/50 focus:bg-muted/50"
                  : "bg-primary/10 hover:bg-primary/20 text-primary border-primary/20"
              )}
              size="sm"
            >
              <SelectValue>
                {permissionMode === "build" ? "Build" : "Ask"}
              </SelectValue>
            </MiniSelectTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <span>Permission: Ask = read-only tools, Build = can write/run</span>
          </TooltipContent>
        </Tooltip>
        <SelectContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
          <SelectItem value="ask">
            <div className="flex flex-col items-start">
              <span className="font-medium">Ask</span>
              <span className="text-xs text-muted-foreground">
                Read-only tools only
              </span>
            </div>
          </SelectItem>
          <SelectItem value="build">
            <div className="flex flex-col items-start">
              <span className="font-medium">Build</span>
              <span className="text-xs text-muted-foreground">
                Can write and run
              </span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
      <TourHelpButton featureId="agents" label="Agent & permission tour" className="shrink-0" />
    </div>
  );
}
