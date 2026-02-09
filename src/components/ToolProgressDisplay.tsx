/**
 * Tool Execution Progress UI
 * ===========================
 * StackSense-inspired progress bars and status display for AI tool calls
 */

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, Clock, Bot, Wrench } from "lucide-react";

export interface ToolExecutionProgress {
    toolName: string;
    status: "pending" | "running" | "complete" | "error";
    progress?: number; // 0-100
    message?: string;
    startTime?: number;
    endTime?: number;
}

export interface ToolProgressDisplayProps {
    tools: ToolExecutionProgress[];
    aiThoughts?: string;
    onDismiss?: () => void;
}

export function ToolProgressDisplay({
    tools,
    aiThoughts,
    onDismiss,
}: ToolProgressDisplayProps) {
    if (tools.length === 0 && !aiThoughts) return null;

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed bottom-24 right-6 w-96 bg-background border border-border rounded-lg shadow-2xl overflow-hidden z-50"
        >
            {/* AI Thoughts Section */}
            {aiThoughts && (
                <div className="bg-blue-500/10 border-b border-blue-500/20 p-4">
                    <div className="flex items-start gap-2">
                        <div className="text-blue-500 mt-0.5">
                            <Loader2 className="w-4 h-4 animate-spin" />
                        </div>
                        <div>
                            <div className="text-sm font-medium text-blue-400 mb-1 flex items-center gap-1.5">
                                <Bot className="w-4 h-4" />
                                AI Thoughts
                            </div>
                            <div className="text-xs text-muted-foreground leading-relaxed">
                                {aiThoughts}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Tools Section */}
            {tools.length > 0 && (
                <div className="p-4 space-y-3 max-h-[400px] overflow-y-auto">
                    <div className="text-sm font-medium text-foreground mb-2 flex items-center gap-1.5">
                        <Wrench className="w-4 h-4" />
                        Tools Used ({tools.filter((t) => t.status === "complete").length}/
                        {tools.length})
                    </div>

                    <AnimatePresence mode="popLayout">
                        {tools.map((tool, index) => (
                            <ToolProgressItem key={`${tool.toolName}-${index}`} tool={tool} />
                        ))}
                    </AnimatePresence>
                </div>
            )}

            {/* Dismiss Button */}
            {onDismiss && tools.every((t) => t.status === "complete" || t.status === "error") && (
                <div className="border-t border-border p-2">
                    <button
                        onClick={onDismiss}
                        className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                        Dismiss
                    </button>
                </div>
            )}
        </motion.div>
    );
}

function ToolProgressItem({ tool }: { tool: ToolExecutionProgress }) {
    const statusConfig = {
        pending: {
            icon: <Clock className="w-4 h-4 text-muted-foreground" />,
            bgColor: "bg-muted/50",
            textColor: "text-muted-foreground",
            borderColor: "border-muted",
        },
        running: {
            icon: <Loader2 className="w-4 h-4 text-primary animate-spin" />,
            bgColor: "bg-primary/10",
            textColor: "text-primary",
            borderColor: "border-primary/30",
        },
        complete: {
            icon: <CheckCircle2 className="w-4 h-4 text-green-500" />,
            bgColor: "bg-green-500/10",
            textColor: "text-green-500",
            borderColor: "border-green-500/30",
        },
        error: {
            icon: (
                <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-white text-xs">
                    !
                </div>
            ),
            bgColor: "bg-red-500/10",
            textColor: "text-red-500",
            borderColor: "border-red-500/30",
        },
    };

    const config = statusConfig[tool.status];
    const duration = tool.endTime && tool.startTime
        ? `${((tool.endTime - tool.startTime) / 1000).toFixed(1)}s`
        : null;

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className={`border ${config.borderColor} ${config.bgColor} rounded-md p-3 transition-all`}
        >
            <div className="flex items-start gap-3">
                <div className="mt-0.5">{config.icon}</div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                        <div className={`text-sm font-medium ${config.textColor} truncate`}>
                            {formatToolName(tool.toolName)}
                        </div>
                        {duration && (
                            <div className="text-xs text-muted-foreground shrink-0">
                                {duration}
                            </div>
                        )}
                    </div>

                    {tool.message && (
                        <div className="text-xs text-muted-foreground mb-2 line-clamp-2">
                            {tool.message}
                        </div>
                    )}

                    {/* Progress Bar */}
                    {tool.status === "running" && tool.progress !== undefined && (
                        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                            <motion.div
                                className="h-full bg-primary"
                                initial={{ width: 0 }}
                                animate={{ width: `${tool.progress}%` }}
                                transition={{ duration: 0.3 }}
                            />
                        </div>
                    )}

                    {/* Indeterminate Progress */}
                    {tool.status === "running" && tool.progress === undefined && (
                        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                            <motion.div
                                className="h-full w-1/3 bg-primary"
                                animate={{
                                    x: ["0%", "300%"],
                                }}
                                transition={{
                                    duration: 1.5,
                                    repeat: Infinity,
                                    ease: "linear",
                                }}
                            />
                        </div>
                    )}
                </div>
            </div>
        </motion.div>
    );
}

function formatToolName(toolName: string): string {
    // Convert snake_case to Title Case
    return toolName
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

// Hook to track tool execution progress
export function useToolProgress() {
    const [tools, setTools] = React.useState<ToolExecutionProgress[]>([]);
    const [aiThoughts, setAiThoughts] = React.useState<string>("");

    const startTool = React.useCallback((toolName: string, message?: string) => {
        setTools((prev) => [
            ...prev,
            {
                toolName,
                status: "running",
                message,
                startTime: Date.now(),
            },
        ]);
    }, []);

    const updateTool = React.useCallback(
        (toolName: string, updates: Partial<ToolExecutionProgress>) => {
            setTools((prev) =>
                prev.map((tool) =>
                    tool.toolName === toolName && tool.status === "running"
                        ? { ...tool, ...updates }
                        : tool
                )
            );
        },
        []
    );

    const completeTool = React.useCallback((toolName: string, message?: string) => {
        setTools((prev) =>
            prev.map((tool) =>
                tool.toolName === toolName && tool.status === "running"
                    ? {
                        ...tool,
                        status: "complete" as const,
                        message: message || tool.message,
                        endTime: Date.now(),
                        progress: 100,
                    }
                    : tool
            )
        );
    }, []);

    const errorTool = React.useCallback((toolName: string, error: string) => {
        setTools((prev) =>
            prev.map((tool) =>
                tool.toolName === toolName && tool.status === "running"
                    ? {
                        ...tool,
                        status: "error" as const,
                        message: error,
                        endTime: Date.now(),
                    }
                    : tool
            )
        );
    }, []);

    const clear = React.useCallback(() => {
        setTools([]);
        setAiThoughts("");
    }, []);

    return {
        tools,
        aiThoughts,
        setAiThoughts,
        startTool,
        updateTool,
        completeTool,
        errorTool,
        clear,
    };
}
