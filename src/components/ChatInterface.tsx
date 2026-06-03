/**
 * Chat Interface Component
 * ========================
 * Main chat area with messages and tool visualizations
 */

import { useRef, useEffect, useMemo } from 'react';
import { ToolCallCard } from './ToolCallCard';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCalls?: ToolCall[];
    timestamp: Date;
}

interface ToolCall {
    id: string;
    name: string;
    status: 'running' | 'complete' | 'error';
    params: Record<string, any>;
    result?: any;
}

interface ChatInterfaceProps {
    messages: Message[];
    isThinking?: boolean;
}

export function ChatInterface({ messages, isThinking }: ChatInterfaceProps) {
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    return (
        <div
            className="chat-interface"
            style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                background: 'var(--obsidian-graphite)',
            }}
        >
            {/* Messages Container */}
            <div
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px',
                }}
            >
                {messages.length === 0 ? (
                    <EmptyState />
                ) : (
                    messages.map(message => (
                        <MessageBubble key={message.id} message={message} />
                    ))
                )}

                {/* Thinking Indicator */}
                {isThinking && <ThinkingIndicator />}

                <div ref={messagesEndRef} />
            </div>
        </div>
    );
}

function EmptyState() {
    return (
        <div
            style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '16px',
                color: 'var(--secondary-text)',
            }}
        >
            <svg
                width="64"
                height="64"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--teal-glow)"
                strokeWidth="1.5"
            >
                <path d="M12 2L2 7L12 12L22 7L12 2Z" />
                <path d="M2 17L12 22L22 17" />
                <path d="M2 12L12 17L22 12" />
            </svg>

            <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px', color: 'var(--primary-text)' }}>
                    Welcome to Atlarix
                </div>
                <div style={{ fontSize: '14px' }}>
                    Ask me anything about your code, or try:
                </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
                <SuggestionChip text="Analyze this codebase" />
                <SuggestionChip text="Generate a Next.js app with authentication" />
                <SuggestionChip text="Show me the architecture diagram" />
                <SuggestionChip text="Search web for React best practices" />
            </div>
        </div>
    );
}

function SuggestionChip({ text }: { text: string }) {
    return (
        <button
            style={{
                padding: '10px 16px',
                background: 'var(--graphite-hover)',
                border: '1px solid var(--graphite-border)',
                borderRadius: '8px',
                color: 'var(--primary-text)',
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s',
            }}
            onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--slate-charcoal)';
                e.currentTarget.style.borderColor = 'var(--teal-glow)';
            }}
            onMouseLeave={e => {
                e.currentTarget.style.background = 'var(--graphite-hover)';
                e.currentTarget.style.borderColor = 'var(--graphite-border)';
            }}
        >
            {text}
        </button>
    );
}

function AssistantMessageHtml({ content }: { content: string }) {
    const safeHtml = useMemo(() => {
        const raw =
            typeof content === "string"
                ? (marked.parse(content) as string)
                : String(content);
        return DOMPurify.sanitize(raw);
    }, [content]);

    return <div dangerouslySetInnerHTML={{ __html: safeHtml }} />;
}

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === 'user';

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                gap: '8px',
            }}
        >
            {/* Message Header */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '12px',
                    color: 'var(--secondary-text)',
                }}
            >
                <span style={{ fontWeight: 600 }}>{isUser ? 'You' : 'Atlarix'}</span>
                <span>{formatTime(message.timestamp)}</span>
            </div>

            {/* Message Content */}
            <div
                style={{
                    maxWidth: '80%',
                    padding: '12px 16px',
                    borderRadius: '12px',
                    background: isUser ? 'var(--teal-glow)' : 'var(--slate-charcoal)',
                    color: isUser ? 'var(--obsidian-graphite)' : 'var(--primary-text)',
                    fontSize: '14px',
                    lineHeight: '1.6',
                }}
            >
                {isUser ? (
                    message.content
                ) : (
                    <AssistantMessageHtml content={message.content} />
                )}
            </div>

            {/* Tool Calls */}
            {message.toolCalls && message.toolCalls.length > 0 && (
                <div style={{ width: '100%', maxWidth: '80%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {message.toolCalls.map(tool => (
                        <ToolCallCard key={tool.id} tool={tool} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                background: 'linear-gradient(90deg, var(--slate-charcoal), var(--graphite-hover), var(--slate-charcoal))',
                backgroundSize: '200% 100%',
                animation: 'shimmer 2s infinite',
                borderRadius: '12px',
                maxWidth: '200px',
            }}
        >
            <div
                style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: 'var(--purple-accent)',
                    animation: 'pulse 1.5s infinite',
                }}
            />
            <span style={{ color: 'var(--purple-accent)', fontSize: '14px', fontWeight: 500 }}>
                Thinking...
            </span>
        </div>
    );
}

function formatTime(date: Date): string {
    return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    }).format(date);
}
