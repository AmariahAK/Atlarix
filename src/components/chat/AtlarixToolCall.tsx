/**
 * Atlarix Native Tool Call Component
 * ===================================
 * Renders native tool call execution in chat
 * Uses enhanced ToolCallCard for display
 */

import React, { useMemo, useState } from "react";
import { ToolCallCard, ToolCallData, ToolStatus } from "../ToolCallCard";

interface AtlarixToolCallProps {
    node?: any;
    children?: React.ReactNode;
}

export const AtlarixToolCall: React.FC<AtlarixToolCallProps> = ({
    node,
    children,
}) => {
    const toolName: string = node?.properties?.tool || node?.properties?.name || "";
    const status: string = node?.properties?.status || "complete";
    const error: string = node?.properties?.error || "";

    const raw = typeof children === "string" ? children : String(children ?? "");

    // Parse parameters from content
    const params = useMemo(() => {
        try {
            const parsed = JSON.parse(raw);
            return parsed;
        } catch {
            return raw ? { input: raw } : {};
        }
    }, [raw]);

    // Map status string to ToolStatus type
    const toolStatus: ToolStatus = useMemo(() => {
        switch (status.toLowerCase()) {
            case 'running':
            case 'pending':
                return 'running';
            case 'error':
            case 'failed':
                return 'error';
            case 'complete':
            case 'success':
            case 'done':
            default:
                return 'complete';
        }
    }, [status]);

    const toolData: ToolCallData = {
        name: toolName,
        status: toolStatus,
        params,
        error: error || undefined,
    };

    return <ToolCallCard tool={toolData} />;
};

export default AtlarixToolCall;
