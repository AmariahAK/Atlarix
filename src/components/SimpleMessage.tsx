/**
 * SimpleMessage
 * =============
 * A simplified message component without router dependencies.
 * Receives isStreaming as prop instead of from useStreamChat hook.
 */

import type { Message } from "@/ipc/ipc_types";
import {
    AtlarixMarkdownParser,
    CHAT_MESSAGE_MARKDOWN_PROSE,
    VanillaMarkdownParser,
} from "./chat/AtlarixMarkdownParser";
import { motion } from "framer-motion";
import { Copy, Check, Bot, Edit2 } from "lucide-react";
import { useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { MessageSources } from "./MessageSources";
import { AttachmentChip } from "./chat/AttachmentChip";

interface SimpleMessageProps {
    message: Message;
    isStreaming?: boolean;
    onEditUserMessage?: (messageId: number, newContent: string) => Promise<void>;
}

export function SimpleMessage({
    message,
    isStreaming = false,
    onEditUserMessage,
}: SimpleMessageProps) {
    const [copied, setCopied] = useState(false);
    const { settings } = useSettings();
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(message.content);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            console.error("Failed to copy:", error);
        }
    };

    const isUser = message.role === "user";
    const isAssistant = message.role === "assistant";

    // Get display name for the model (supports object { provider, name } or legacy string)
    const getModelDisplayName = () => {
        const model = settings?.selectedModel as { provider?: string; name?: string } | string | undefined;
        if (!model) return 'Atlarix AI';

        if (typeof model === 'string') {
            const parts = model.split('/');
            const modelName = parts[parts.length - 1];
            return formatModelName(modelName);
        }

        if (model.provider === 'auto') {
            const ids = settings?.autoModelIds;
            if (Array.isArray(ids) && ids.length === 3 && ids.every(Boolean)) {
                const [fast, medium, thinking] = ids;
                const short = (s: string) => s.split('/').pop()?.replace(/-/g, ' ') ?? s;
                return `Auto (${short(fast)} / ${short(medium)} / ${short(thinking)})`;
            }
            return 'Auto (Fast / Medium / Thinking)';
        }

        const name = model.name ?? '';
        const parts = name.split('/');
        const modelName = parts[parts.length - 1] || name;
        return formatModelName(modelName);
    };

    function formatModelName(modelName: string): string {
        return modelName
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .replace(/Gpt/g, 'GPT')
            .replace(/Deepseek/g, 'DeepSeek')
            .replace(/Claude/g, 'Claude')
            .replace(/Gemini/g, 'Gemini')
            .replace(/Qwen/g, 'Qwen')
            .replace(/Pony/g, 'Pony')
            .replace(/Minimax/g, 'MiniMax');
    }

    return (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-3xl ${isUser ? "ml-12" : "mr-12"}`}>
                {/* Model name header for assistant messages */}
                {isAssistant && (
                    <div className="flex items-center gap-2 flex-wrap mb-1.5 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                            <Bot className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-medium">{getModelDisplayName()}</span>
                        </span>
                        {settings?.agentMode === "guided" && (
                            <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium" title="Guided: sub-agents can be used for complex tasks">
                                Guided
                            </span>
                        )}
                        {settings?.agentMode === "autonomous" && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium" title="Autonomous: agents can act with approval">
                                Autonomous
                            </span>
                        )}
                    </div>
                )}

                <div
                    className={`rounded-lg p-3 ${isUser
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                        }`}
                >
                    {/* Typing indicator for empty assistant message while streaming */}
                    {isAssistant && !message.content && isStreaming ? (
                        <div className="flex h-6 items-center space-x-2">
                            <motion.div
                                className="h-2 w-2 rounded-full bg-current opacity-60"
                                animate={{ y: [0, -8, 0] }}
                                transition={{
                                    repeat: Infinity,
                                    duration: 0.6,
                                    ease: "easeInOut",
                                }}
                            />
                            <motion.div
                                className="h-2 w-2 rounded-full bg-current opacity-60"
                                animate={{ y: [0, -8, 0] }}
                                transition={{
                                    repeat: Infinity,
                                    duration: 0.6,
                                    ease: "easeInOut",
                                    delay: 0.15,
                                }}
                            />
                            <motion.div
                                className="h-2 w-2 rounded-full bg-current opacity-60"
                                animate={{ y: [0, -8, 0] }}
                                transition={{
                                    repeat: Infinity,
                                    duration: 0.6,
                                    ease: "easeInOut",
                                    delay: 0.3,
                                }}
                            />
                        </div>
                    ) : (
                        <div className={CHAT_MESSAGE_MARKDOWN_PROSE} style={{ whiteSpace: 'pre-wrap' }}>
                            {isUser &&
                                message.attachments &&
                                message.attachments.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mb-2">
                                        {message.attachments.map((att) => (
                                            <AttachmentChip
                                                key={att.id}
                                                id={att.id}
                                                filename={att.filename}
                                                mimeType={att.mimeType}
                                                size={att.size}
                                            />
                                        ))}
                                    </div>
                                )}

                            {isUser && isEditing ? (
                                <div className="space-y-2">
                                    <textarea
                                        value={editContent}
                                        onChange={(e) => setEditContent(e.target.value)}
                                        className="w-full min-h-[120px] rounded-md border border-border/50 bg-background/70 p-2 text-sm text-foreground"
                                    />
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                try {
                                                    await onEditUserMessage?.(message.id, editContent);
                                                    setIsEditing(false);
                                                } catch (err) {
                                                    console.error("Failed to edit message:", err);
                                                }
                                            }}
                                            className="px-2 py-1 rounded-md bg-background/70 border border-border/50 text-xs text-foreground hover:bg-background transition-colors"
                                        >
                                            Save
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setEditContent(message.content);
                                                setIsEditing(false);
                                            }}
                                            className="px-2 py-1 rounded-md bg-background/40 border border-border/40 text-xs text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            ) : isAssistant ? (
                                <AtlarixMarkdownParser content={message.content} />
                            ) : (
                                <VanillaMarkdownParser content={message.content} />
                            )}

                            {/* Streaming indicator */}
                            {isAssistant && isStreaming && message.content && (
                                <span className="inline-block w-2 h-4 ml-1 bg-primary animate-pulse" />
                            )}
                        </div>
                    )}
                </div>

                {/* Display sources for assistant messages if available */}
                {isAssistant && message.sources && message.sources.length > 0 && (
                    <MessageSources sources={message.sources} />
                )}

                {/* Actions under messages */}
                {message.content && !isStreaming && (
                    <div className={`flex mt-1 ${isUser ? "justify-end" : "justify-start"}`}>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={handleCopy}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
                            >
                                {copied ? (
                                    <>
                                        <Check className="h-3 w-3 text-green-500" />
                                        Copied
                                    </>
                                ) : (
                                    <>
                                        <Copy className="h-3 w-3" />
                                        Copy
                                    </>
                                )}
                            </button>
                            {isUser && !isEditing && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setEditContent(message.content);
                                        setIsEditing(true);
                                    }}
                                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
                                    title="Edit"
                                    aria-label="Edit message"
                                >
                                    <Edit2 className="h-3 w-3" />
                                    Edit
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

