import React, { useState } from "react";
import { Brain, ChevronDown, ChevronUp, Loader } from "lucide-react";
import { VanillaMarkdownParser } from "./AtlarixMarkdownParser";
import { CustomTagState } from "./stateTypes";
import { AtlarixTokenSavings } from "./AtlarixTokenSavings";

interface AtlarixThinkProps {
  node?: any;
  children?: React.ReactNode;
}

export const AtlarixThink: React.FC<AtlarixThinkProps> = ({ children, node }) => {
  const state = node?.properties?.state as CustomTagState;
  const inProgress = state === "pending";
  // Default to collapsed - user can expand if they want to see the thought
  const [isExpanded, setIsExpanded] = useState(false);

  // Check if content matches token savings format
  const tokenSavingsMatch =
    typeof children === "string"
      ? children.match(
        /^dyad-token-savings\?original-tokens=([0-9.]+)&smart-context-tokens=([0-9.]+)$/,
      )
      : null;

  // Get preview text (first 100 chars) for collapsed state
  const getPreviewText = () => {
    if (typeof children === "string") {
      const text = children.replace(/[#*`]/g, '').trim();
      return text.length > 100 ? text.substring(0, 100) + "..." : text;
    }
    return "Click to view thought process...";
  };

  // If it's token savings format, render AtlarixTokenSavings component
  if (tokenSavingsMatch) {
    const originalTokens = parseFloat(tokenSavingsMatch[1]);
    const smartContextTokens = parseFloat(tokenSavingsMatch[2]);
    return (
      <AtlarixTokenSavings
        originalTokens={originalTokens}
        smartContextTokens={smartContextTokens}
      />
    );
  }

  return (
    <div
      className={`relative bg-(--background-lightest) dark:bg-zinc-900 hover:bg-(--background-lighter) rounded-lg px-4 py-2 border my-2 cursor-pointer ${inProgress ? "border-purple-500 animate-pulse" : "border-border"
        }`}
      onClick={() => setIsExpanded(!isExpanded)}
      role="button"
      aria-expanded={isExpanded}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setIsExpanded(!isExpanded);
        }
      }}
    >
      {/* Top-left label badge */}
      <div
        className="absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold text-purple-500 bg-white dark:bg-zinc-900"
        style={{ zIndex: 1 }}
      >
        <Brain size={16} className="text-purple-500" />
        <span>{inProgress ? "Thinking" : "Thought"}</span>
        {inProgress && (
          <Loader size={14} className="ml-1 text-purple-500 animate-spin" />
        )}
      </div>

      {/* Indicator icon */}
      <div className="absolute top-2 right-2 p-1 text-gray-500">
        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </div>

      {/* Preview text when collapsed */}
      {!isExpanded && (
        <div className="pt-6 text-xs text-muted-foreground italic line-clamp-1">
          {getPreviewText()}
        </div>
      )}

      {/* Main content with smooth transition */}
      <div
        className="pt-6 overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: isExpanded ? "2000px" : "0px",
          opacity: isExpanded ? 1 : 0,
        }}
      >
        <div className="px-0 text-sm text-gray-600 dark:text-gray-300">
          {typeof children === "string" ? (
            <VanillaMarkdownParser content={children} />
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
};
