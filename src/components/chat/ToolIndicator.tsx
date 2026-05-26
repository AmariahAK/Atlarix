import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { isStreamingByIdAtom, toolIndicatorAtom } from "@/atoms/chatAtoms";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ToolCategory, ToolRegistry } from "@/lib/tools/registry";
import { useSettings } from "@/hooks/useSettings";
import type { WorkMode } from "@/lib/schemas";

export type ToolIndicatorProps = {
  /** When set, only show status for this chat (avoids wrong session in multi-chat UIs). */
  forChatId?: number;
};

export type ToolLabelGroup = "readonly" | "write" | "web" | "mcp" | "default";

const WEB_TOOL_NAMES = new Set([
  "web_search",
  "deep_search",
  "read_url",
  "fetch_url",
]);

/**
 * Provider-agnostic grouping from stable tool id (registry name or MCP composite key).
 */
export function classifyTool(toolIdOrName: string): ToolLabelGroup {
  const id = toolIdOrName.trim();
  if (!id) return "default";
  // MCP tools use `server__tool` keys from getMcpTools
  if (/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/.test(id)) {
    return "mcp";
  }
  const meta = ToolRegistry.get(id);
  if (meta) {
    if (meta.category === ToolCategory.WEB || WEB_TOOL_NAMES.has(id)) {
      return "web";
    }
    if (meta.isReadOnly === true) {
      return "readonly";
    }
    return "write";
  }
  return "default";
}

/** Idle strip text when no tool is active yet. */
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

export function groupToLabel(group: ToolLabelGroup, humanToolName: string): string {
  switch (group) {
    case "readonly":
      return "Reading your codebase…";
    case "write":
      return "Modifying the codebase…";
    case "web":
      return "Searching the web…";
    case "mcp": {
      const tail = humanToolName.trim() || "MCP tool";
      return `Checking ${tail}…`;
    }
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
 * Persistent working strip: submit → stream done; labels from tool groups, counsel, or autonomous bus.
 */
export function ToolIndicator({ forChatId }: ToolIndicatorProps = {}) {
  const state = useAtomValue(toolIndicatorAtom);
  const setState = useSetAtom(toolIndicatorAtom);
  const { settings } = useSettings();
  const streamingById = useAtomValue(isStreamingByIdAtom);
  const activityItems = useAtomValue(activityStreamItemsAtom);
  const workMode = settings?.workModePreference;
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<
    "error_first" | "progress_first" | "raw_capped"
  >("error_first");

  const targetChatId = forChatId ?? state.activeChatId;
  const isTargetStreaming =
    targetChatId != null && streamingById.get(targetChatId) === true;

  const autonomousOverride = useMemo(
    () => autonomousBusActiveForChat(activityItems, targetChatId ?? undefined),
    [activityItems, targetChatId],
  );

  // Tool start/end IPC is handled in useStreamChat only (avoids double count).

  useEffect(() => {
    const unsub = IpcClient.getInstance().onStreamPhase(({ chatId, phase, label }) => {
      setState((prev) => {
        if (phase === "counsel_start") {
          return {
            ...prev,
            counselPhaseActive: true,
            activeChatId: chatId,
          };
        }
        if (phase === "counsel_end") {
          if (prev.activeChatId !== chatId) return prev;
          return { ...prev, counselPhaseActive: false };
        }
        if (phase === "done") {
          if (prev.activeChatId !== chatId) return prev;
          return {
            ...prev,
            active: false,
            toolName: null,
            toolId: null,
            count: 0,
            counselPhaseActive: false,
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
            activeChatId: chatId,
          };
        }
        if (phase === "responding") {
          if (prev.activeChatId !== chatId) return prev;
          return { ...prev, phaseLabel: null };
        }
        return prev;
      });
    });
    return unsub;
  }, [setState]);

  if (
    forChatId !== undefined &&
    state.activeChatId !== null &&
    state.activeChatId !== forChatId
  ) {
    return null;
  }

  const showStrip =
    targetChatId != null &&
    isTargetStreaming &&
    (state.activeChatId === targetChatId || state.activeChatId === null) &&
    (state.active ||
      state.count > 0 ||
      state.counselPhaseActive ||
      Boolean(state.phaseLabel?.trim()));

  if (!showStrip) return null;

  const idleDefault = idleLabelForWorkMode(workMode);
  let displayLine = state.phaseLabel?.trim() || idleDefault;
  if (autonomousOverride) {
    displayLine = "Splitting to autonomous agents…";
  } else if (state.counselPhaseActive) {
    displayLine = "Consulting multiple models…";
  } else if (state.count > 0 && state.toolName?.trim()) {
    const specific = state.toolName.trim();
    const key = state.toolId ?? specific;
    displayLine =
      specific.includes("…") || specific.includes("...")
        ? specific
        : groupToLabel(classifyTool(key), specific);
  }

  const showToolRow = state.count > 0 && Boolean(state.toolName);
  const showLiveOutput = showToolRow && state.liveOutputLines.length > 0;

  const effectiveMode = viewMode ?? state.liveViewMode ?? "error_first";
  const lines =
    effectiveMode === "raw_capped"
      ? state.liveOutputLines
      : effectiveMode === "progress_first"
        ? state.liveProgressLines
        : state.liveErrorLines.length > 0
          ? state.liveErrorLines
          : state.liveOutputLines;
  const text = lines.join("\n");

  return (
    <div className="rounded-lg border border-border bg-muted/50 text-muted-foreground text-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="shrink-0">
          <AtlarixAnimation size="xs" phase="thinking" />
        </div>
        <span className="flex-1 font-medium">{displayLine}</span>
      </div>
      {showLiveOutput && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setOutputExpanded((e) => !e)}
            className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-muted/50"
          >
            <div className="flex items-center gap-2">
              {outputExpanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <span>{outputExpanded ? "Hide output" : "Show output"}</span>
            </div>
            <div className="flex items-center gap-1">
              {(["error_first", "progress_first", "raw_capped"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setViewMode(m);
                  }}
                  className={`rounded px-2 py-0.5 text-[10px] border ${viewMode === m ? "bg-muted text-foreground border-border" : "border-border text-muted-foreground hover:text-foreground"}`}
                  title={m === "error_first" ? "Errors" : m === "progress_first" ? "Progress" : "Raw"}
                >
                  {m === "error_first" ? "Errors" : m === "progress_first" ? "Progress" : "Raw"}
                </button>
              ))}
            </div>
          </button>
          {outputExpanded && (
            <pre className="px-3 py-2 max-h-40 overflow-auto text-xs font-mono bg-background/50 whitespace-pre-wrap break-words border-t border-border">
              {text || "(no output yet)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
