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

export interface Workspace {
    id: string;
    name: string;
    path: string;
}

export interface Model {
    id: string;
    name: string;
    provider: 'ollama' | 'lmstudio' | 'openrouter';
    status: 'connected' | 'disconnected' | 'error';
}

export interface User {
    id: string;
    email: string;
    subscription_type: 'free' | 'monthly_pro' | 'annual_pro' | 'annual_license';
    prompts_used_today: number;
    prompts_limit: number;
}

export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
    favicon?: string;
}

export interface DiagramData {
    type: 'architecture' | 'class' | 'sequence';
    mermaidCode: string;
    title?: string;
}

export interface FilePreview {
    filename: string;
    code: string;
    language: string;
}
