/**
 * SimpleMessage
 * =============
 * A simplified message component without router dependencies.
 * Receives isStreaming as prop instead of from useStreamChat hook.
 */

import type { Message } from "@/ipc/ipc_types";
import { resolvePasteAttachmentsForMessage } from "@/lib/chat/paste-attachment-meta";
import {
    CHAT_MESSAGE_MARKDOWN_PROSE,
    UserMessageMarkdownParser,
} from "./chat/AtlarixMarkdownParser";
import { AssistantMessageBody } from "./chat/AssistantMessageBody";
import { InlineStreamStatus } from "./chat/InlineStreamStatus";
import { Copy, Check, Bot, Edit2 } from "lucide-react";
import { useState } from "react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { showSuccess } from "@/lib/toast";
import { useAtomValue } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { MessageSources } from "./MessageSources";
import { AttachmentChip } from "./chat/AttachmentChip";
import { currentAppAtom, selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import type { WorkMode } from "@/lib/schemas";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { resolveModelDisplayLabel } from "@/lib/resolve-model-display-label";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { labelForWorkMode, settingsPatchForWorkMode } from "@/lib/work-mode";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { showError } from "@/lib/toast";
import {
    resolveWorkspaceAppId,
    showWorkspaceModeControls as shouldShowWorkspaceModeControls,
} from "@/lib/chat/show-workspace-mode-controls";

const WORK_MODES: WorkMode[] = ["ask", "plan", "build", "debug", "review"];

interface SimpleMessageProps {
    message: Message;
    chatId?: number;
    /** Workspace bound to this chat (from getChat.appId). */
    workspaceAppId?: number | null;
    isStreaming?: boolean;
    /** Last assistant message in the thread — keeps the settled "A" indicator after the turn completes. */
    isLatestAssistant?: boolean;
    onEditUserMessage?: (messageId: number, newContent: string) => Promise<void>;
}

export function SimpleMessage({
    message,
    chatId: chatIdProp,
    workspaceAppId,
    isStreaming = false,
    isLatestAssistant = false,
    onEditUserMessage,
}: SimpleMessageProps) {
    const [copied, setCopied] = useState(false);
    const { copyMessageContent, copied: assistantCopied } = useCopyToClipboard();
    const { settings, updateSettings } = useSettings();
    const { data: coreCatalog = [] } = useAtlarixCoreCatalog();
    const { data: modelsByProviders } = useLanguageModelsByProviders();
    const appId = useAtomValue(selectedAppIdAtom);
    const currentApp = useAtomValue(currentAppAtom);
    const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
    const activeChatId = useAtomValue(activeChatIdAtom);
    const chatId = chatIdProp ?? activeChatId;
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(message.content);
    const [editMode, setEditMode] = useState<WorkMode>(
        () =>
            (message.workMode as WorkMode | null | undefined) ??
            settings?.workModePreference ??
            "ask",
    );

    const resolvedWorkspaceAppId = resolveWorkspaceAppId({
        workspaceAppId,
        selectedAppId: appId,
        currentAppId: currentApp?.id ?? null,
        workspaceInfoId: workspaceInfo?.id ?? null,
    });
    const showWorkspaceModeControls = shouldShowWorkspaceModeControls(
        message,
        resolvedWorkspaceAppId,
    );

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            console.error("Failed to copy:", error);
        }
    };

    const handleAssistantCopy = async () => {
        const ok = await copyMessageContent(message.content);
        if (ok) showSuccess("Copied to clipboard");
    };

    const isUser = message.role === "user";
    const isAssistant = message.role === "assistant";

    const getModelDisplayName = () =>
        resolveModelDisplayLabel(settings?.selectedModel, {
            catalog: coreCatalog,
            modelsByProviders,
        });

    return (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div className={`group max-w-3xl ${isUser ? "ml-12" : "mr-12"}`}>
                {/* Model name header for assistant messages */}
                {isAssistant && (
                    <div className="flex items-center gap-2 flex-wrap mb-1.5 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                            <Bot className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-medium">{getModelDisplayName()}</span>
                        </span>
                    </div>
                )}

                <div
                    className={`rounded-lg p-3 ${isUser
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                        }`}
                >
                    {/* Working indicator for empty assistant message while streaming */}
                    {isAssistant && !message.content && isStreaming ? (
                        <InlineStreamStatus chatId={chatId ?? message.chatId} active />
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
                                <textarea
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    className="w-full min-h-[120px] rounded-md border border-border/50 bg-background/70 p-2 text-sm text-foreground"
                                    autoFocus
                                />
                            ) : isAssistant ? (
                                <AssistantMessageBody
                                    content={message.content ?? ""}
                                    assistantMessageId={message.id}
                                    chatId={chatId ?? message.chatId}
                                    isStreaming={isStreaming}
                                    contentDrivenThread={false}
                                />
                            ) : (
                                <UserMessageMarkdownParser
                                    content={message.content}
                                    pasteAttachments={(() => {
                                        const pastes =
                                            resolvePasteAttachmentsForMessage(message);
                                        return pastes.length > 0 ? pastes : undefined;
                                    })()}
                                />
                            )}


                            {/* Inline compass: loops while this turn streams, settles into "A" when done */}
                            {isAssistant && message.content && (isStreaming || isLatestAssistant) && (
                                <InlineStreamStatus
                                    chatId={chatId ?? message.chatId}
                                    active={isStreaming}
                                />
                            )}
                        </div>
                    )}
                </div>

                {/* Display sources for assistant messages if available */}
                {isAssistant && message.sources && message.sources.length > 0 && (
                    <MessageSources sources={message.sources} />
                )}

                {/* Actions under messages — Copy / Edit / Mode / Save / Cancel */}
                {isAssistant && message.content && !isStreaming && (
                    <div className="flex mt-1 justify-start opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                            type="button"
                            onClick={handleAssistantCopy}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
                        >
                            {assistantCopied ? (
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
                {isUser && (message.content || isEditing) && !isStreaming && (
                    <div className="flex mt-1 justify-end">
                        <div className="flex flex-wrap items-center gap-1">
                            <button
                                type="button"
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
                            {!isEditing ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setEditContent(message.content);
                                        setEditMode(
                                            (message.workMode as WorkMode | null | undefined) ??
                                                settings?.workModePreference ??
                                                "ask",
                                        );
                                        setIsEditing(true);
                                    }}
                                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
                                    title="Edit"
                                    aria-label="Edit message"
                                >
                                    <Edit2 className="h-3 w-3" />
                                    Edit
                                </button>
                            ) : (
                                <>
                                    {showWorkspaceModeControls ? (
                                        <>
                                            <span className="text-xs text-muted-foreground px-1">
                                                Mode
                                            </span>
                                            <Select
                                                value={editMode}
                                                onValueChange={(v) => setEditMode(v as WorkMode)}
                                                disabled={isStreaming}
                                            >
                                                <SelectTrigger className="h-7 w-[108px] text-xs border-border bg-background">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {WORK_MODES.map((m) => (
                                                        <SelectItem key={m} value={m} className="text-xs">
                                                            {labelForWorkMode(m)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </>
                                    ) : null}
                                    <button
                                        type="button"
                                        disabled={isStreaming}
                                        onClick={async () => {
                                            try {
                                                if (showWorkspaceModeControls) {
                                                    await updateSettings(
                                                        settingsPatchForWorkMode(editMode),
                                                    );
                                                }
                                                await onEditUserMessage?.(message.id, editContent);
                                                setIsEditing(false);
                                            } catch (err) {
                                                showError(err);
                                            }
                                        }}
                                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted disabled:opacity-40"
                                    >
                                        {showWorkspaceModeControls ? "Send" : "Save"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setEditContent(message.content);
                                            setEditMode(
                                                (message.workMode as WorkMode | null | undefined) ??
                                                    settings?.workModePreference ??
                                                    "ask",
                                            );
                                            setIsEditing(false);
                                        }}
                                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
                                    >
                                        Cancel
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

