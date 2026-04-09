/**
 * Atlarix Native Tool Result Component
 * =====================================
 * Renders native tool execution results in chat
 */

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, CheckCircle2, XCircle } from "lucide-react";
import { CodeHighlight } from "./CodeHighlight";
import {
    HandoffResultCard,
    type HandoffAgentRole,
} from "./HandoffResultCard";

interface AtlarixToolResultProps {
    node?: any;
    children?: React.ReactNode;
}

const HANDOFF_AGENT_ROLES: HandoffAgentRole[] = [
    "research",
    "architect",
    "builder",
    "reviewer",
    "debugger",
];

const SCHEMA_TO_HANDOFF_ROLE: Record<string, HandoffAgentRole> = {
    ArchitectPlanPayload: "architect",
    BuilderExecutionSummary: "builder",
    ReviewerFindings: "reviewer",
    DebuggerRootCause: "debugger",
};

function resolveHandoffAgentRole(parsed: Record<string, unknown>): HandoffAgentRole {
    const r = parsed.agentRole;
    if (
        typeof r === "string" &&
        (HANDOFF_AGENT_ROLES as readonly string[]).includes(r)
    ) {
        return r as HandoffAgentRole;
    }
    const validation = parsed.validation as { schema?: string } | undefined;
    const schema = validation?.schema;
    if (typeof schema === "string" && SCHEMA_TO_HANDOFF_ROLE[schema]) {
        return SCHEMA_TO_HANDOFF_ROLE[schema];
    }
    return "research";
}

export const AtlarixToolResult: React.FC<AtlarixToolResultProps> = ({
    node,
    children,
}) => {
    const toolName: string = node?.properties?.tool || node?.properties?.name || "Tool";
    const status: string = node?.properties?.status || "success";
    const isError = status === "error" || status === "failed";

    const [expanded, setExpanded] = useState(isError); // Auto-expand on error

    const raw = typeof children === "string" ? children : String(children ?? "");

    if (toolName === "delegate_to_agent" && !isError) {
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (
                parsed &&
                typeof parsed === "object" &&
                parsed.success === true
            ) {
                const summary =
                    typeof parsed.summary === "string"
                        ? parsed.summary
                        : String(parsed.summary ?? "");
                const validation = parsed.validation as
                    | { status?: string }
                    | undefined;
                const validationStatus =
                    validation?.status === "fallback"
                        ? "fallback"
                        : "success";
                return (
                    <HandoffResultCard
                        agentRole={resolveHandoffAgentRole(parsed)}
                        summary={summary}
                        structuredPayload={
                            parsed.structuredPayload !== undefined
                                ? parsed.structuredPayload
                                : undefined
                        }
                        validationStatus={validationStatus}
                    />
                );
            }
        } catch {
            /* fall through to default tool result UI */
        }
    }

    // Format result content
    const formattedContent = useMemo(() => {
        if (!expanded) return "";
        try {
            const parsed = JSON.parse(raw);
            return JSON.stringify(parsed, null, 2);
        } catch {
            return raw;
        }
    }, [expanded, raw]);

    // Truncate preview
    const preview = raw.length > 60 ? raw.substring(0, 60) + "..." : raw;

    return (
        <div
            className={`
                relative rounded-lg border my-2 transition-all duration-200 overflow-hidden
                ${isError
                    ? 'border-red-500/30 bg-red-950/20'
                    : 'border-emerald-500/30 bg-emerald-950/10 hover:bg-emerald-950/20'
                }
            `}
        >
            {/* Header */}
            <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
                onClick={() => setExpanded(!expanded)}
            >
                {/* Status icon */}
                {isError ? (
                    <XCircle size={14} className="text-red-400" />
                ) : (
                    <CheckCircle2 size={14} className="text-emerald-400" />
                )}

                {/* Label */}
                <span className={`text-xs font-medium ${isError ? 'text-red-400' : 'text-emerald-400'}`}>
                    {toolName} Result
                </span>

                {/* Preview when collapsed */}
                {!expanded && preview && (
                    <span className="text-xs text-zinc-500 truncate max-w-[300px] font-mono">
                        {preview}
                    </span>
                )}

                {/* Spacer */}
                <div className="flex-1" />

                {/* Expand chevron */}
                {expanded
                    ? <ChevronUp size={14} className="text-zinc-500" />
                    : <ChevronDown size={14} className="text-zinc-500" />
                }
            </div>

            {/* Content */}
            {expanded && (
                <div className="px-3 pb-3 pt-1 border-t border-zinc-800/50">
                    <div className="bg-zinc-950/50 rounded p-2 text-xs max-h-60 overflow-y-auto">
                        <CodeHighlight className="language-json">
                            {formattedContent}
                        </CodeHighlight>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AtlarixToolResult;
