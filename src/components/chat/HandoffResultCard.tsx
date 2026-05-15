/**
 * Renders delegate_to_agent structured handoff in the parent thread (S5b).
 */

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, CheckCircle2, AlertTriangle } from "lucide-react";
import { CodeHighlight } from "./CodeHighlight";
export type HandoffAgentRole =
  | "research"
  | "explore"
  | "scout"
  | "architect"
  | "builder"
  | "reviewer"
  | "debugger";

export interface HandoffResultCardProps {
  agentRole: HandoffAgentRole;
  summary: string;
  /** Validated handoff object from delegate_to_agent (opaque in UI). */
  structuredPayload?: unknown;
  validationStatus: "success" | "fallback";
}

function handoffTitle(role: HandoffAgentRole): string {
  switch (role) {
    case "architect":
      return "Architect returned a plan";
    case "builder":
      return "Builder completed task";
    case "reviewer":
      return "Reviewer returned findings";
    case "debugger":
      return "Debugger returned analysis";
    case "explore":
      return "Explore mapped the codebase";
    case "scout":
      return "Scout traced dependencies";
    case "research":
    default:
      return "Research completed";
  }
}

export const HandoffResultCard: React.FC<HandoffResultCardProps> = ({
  agentRole,
  summary,
  structuredPayload,
  validationStatus,
}) => {
  const [expanded, setExpanded] = useState(false);
  const title = handoffTitle(agentRole);
  const isFallback = validationStatus === "fallback";

  const preview = useMemo(() => {
    const line = summary.trim().split(/\r?\n/)[0] ?? "";
    return line.length > 72 ? `${line.slice(0, 72)}…` : line;
  }, [summary]);

  const payloadJson = useMemo(() => {
    if (!structuredPayload) return "";
    try {
      return JSON.stringify(structuredPayload, null, 2);
    } catch {
      return String(structuredPayload);
    }
  }, [structuredPayload]);

  return (
    <div
      className={`
        relative rounded-lg border my-2 transition-all duration-200 overflow-hidden
        ${
          isFallback
            ? "border-amber-500/35 bg-amber-950/15 hover:bg-amber-950/25"
            : "border-indigo-500/30 bg-indigo-950/10 hover:bg-indigo-950/20"
        }
      `}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        role="button"
        tabIndex={0}
      >
        {isFallback ? (
          <AlertTriangle size={14} className="text-amber-400 shrink-0" />
        ) : (
          <CheckCircle2 size={14} className="text-indigo-400 shrink-0" />
        )}
        <span
          className={`text-xs font-semibold shrink-0 ${isFallback ? "text-amber-300" : "text-indigo-300"}`}
        >
          {title}
        </span>
        {isFallback && (
          <span className="text-[10px] uppercase tracking-wide text-amber-500/90 font-medium">
            fallback format
          </span>
        )}
        {!expanded && preview && (
          <span className="text-xs text-zinc-500 truncate min-w-0 font-mono">{preview}</span>
        )}
        <div className="flex-1 min-w-2" />
        {expanded ? (
          <ChevronUp size={14} className="text-zinc-500 shrink-0" />
        ) : (
          <ChevronDown size={14} className="text-zinc-500 shrink-0" />
        )}
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-zinc-800/50 space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Summary</div>
            <div className="bg-zinc-950/50 rounded p-2 text-xs max-h-40 overflow-y-auto whitespace-pre-wrap text-zinc-300">
              {summary}
            </div>
          </div>
          {payloadJson && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                Structured payload
              </div>
              <div className="bg-zinc-950/50 rounded p-2 text-xs max-h-60 overflow-y-auto">
                <CodeHighlight className="language-json">{payloadJson}</CodeHighlight>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default HandoffResultCard;
