/**
 * SimpleMessage
 * =============
 * A simplified message component without router dependencies.
 * Receives isStreaming as prop instead of from useStreamChat hook.
 */

import type { Message } from "@/ipc/ipc_types";
import {
    AtlarixMarkdownParser,
    VanillaMarkdownParser,
} from "./chat/AtlarixMarkdownParser";
import { motion } from "framer-motion";
import { Copy, Check, Bot } from "lucide-react";
import { useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { MessageSources } from "./MessageSources";

interface SimpleMessageProps {
    message: Message;
    isStreaming?: boolean;
}

export function SimpleMessage({ message, isStreaming = false }: SimpleMessageProps) {
    const [copied, setCopied] = useState(false);
    const { settings } = useSettings();

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

    // Get display name for the model
    const getModelDisplayName = () => {
        const model = settings?.selectedModel;
        // Check if model exists and is a string before calling .split()
        if (!model || typeof model !== 'string') return 'Atlarix AI';

        // Parse model name for display (e.g., "openai/gpt-4o" -> "GPT-4o")
        const parts = model.split('/');
        const modelName = parts[parts.length - 1];

        // Capitalize and format common model names
        const formatted = modelName
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .replace(/Gpt/g, 'GPT')
            .replace(/Deepseek/g, 'DeepSeek')
            .replace(/Claude/g, 'Claude')
            .replace(/Gemini/g, 'Gemini')
            .replace(/Qwen/g, 'Qwen');

        return formatted;
    };

    return (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-3xl ${isUser ? "ml-12" : "mr-12"}`}>
                {/* Model name header for assistant messages */}
                {isAssistant && (
                    <div className="flex items-center gap-1.5 mb-1.5 text-xs text-muted-foreground">
                        <Bot className="h-3.5 w-3.5" />
                        <span className="font-medium">{getModelDisplayName()}</span>
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
                        <div className="prose dark:prose-invert prose-sm max-w-none break-words" style={{ whiteSpace: 'pre-wrap' }}>
                            {isAssistant ? (
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

                {/* Copy button for assistant messages */}
                {isAssistant && message.content && !isStreaming && (
                    <div className="flex justify-start mt-1">
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
                    </div>
                )}
            </div>
        </div>
    );
}

