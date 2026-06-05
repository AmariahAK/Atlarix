/**
 * TypeScript Type Definitions
 * ===========================
 * Shared types for Atlarix
 */

export interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCalls?: ToolCall[];
    timestamp: Date;
}

export interface ToolCall {
    id: string;
    name: string;
    status: 'running' | 'complete' | 'error';
    params: Record<string, any>;
    result?: any;
}

