/**
 * SimpleMessage
 * =============
 * A simplified message component without router dependencies.
 * Receives isStreaming as prop instead of from useStreamChat hook.
 */

import type { Message } from "@/ipc/ipc_types";
import {
    resolvePasteAttachmentsForMessage,
    lookupTextPasteContent,
    lookupTerminalPasteContent,
} from "@/lib/chat/paste-attachment-meta";
import {
    splitAttachmentTagsForEdit,
    rejoinAttachmentTags,
} from "@/lib/chat/edit-attachment-tags";
import type { ParsedAttachmentTag } from "@/lib/chat/attachment-tag-parse";
import { PastedTextAttachmentChip } from "@/components/chat/PastedTextAttachmentChip";
import { BackgroundJobAttachmentChip } from "@/components/chat/BackgroundJobAttachmentChip";
import { TerminalOutputAttachmentChip } from "@/components/chat/TerminalOutputAttachmentChip";
import {
    CHAT_MESSAGE_MARKDOWN_PROSE,
    UserMessageMarkdownParser,
} from "./chat/AtlarixMarkdownParser";
import { SentMentionChips } from "./chat/SentMentionChips";
import { extractMentions } from "@/lib/chat/mention-attachment";
import { AssistantMessageBody } from "./chat/AssistantMessageBody";
import { InlineStreamStatus } from "./chat/InlineStreamStatus";
import { RevertTurnAction } from "./chat/RevertTurnAction";
import { Copy, Check, Bot, Edit2, RotateCw, AlertTriangle } from "lucide-react";
import { memo, useState } from "react";
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
    /** Issue 4: resume an interrupted assistant turn (partial content preserved). */
    onContinue?: (message: Message) => void;
}

function SimpleMessageImpl({
    message,
    chatId: chatIdProp,
    workspaceAppId,
    isStreaming = false,
    isLatestAssistant = false,
    onEditUserMessage,
    onContinue,
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
    // W5 (v14.8.11): attachment stub tags stripped from the editable text —
    // rendered as read-only chips above the textarea, re-spliced on save.
    const [editTags, setEditTags] = useState<ParsedAttachmentTag[]>([]);
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
                    // The user bubble has its own surface tokens rather than
                    // `bg-primary`: primary is a BUTTON colour, and a
                    // paragraph-sized block of it glares — the more so because
                    // the markdown inside carries `dark:prose-invert`, which
                    // forces light prose text and won over
                    // `text-primary-foreground`'s near-black. White on full
                    // emerald was the result. See globals.css for the pair.
                    className={`rounded-lg p-3 ${isUser
                        ? "bg-user-bubble text-user-bubble-foreground border border-user-bubble-border"
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
                                <>
                                    {editTags.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mb-2">
                                            {editTags.map((tag, ti) => {
                                                const pastes =
                                                    resolvePasteAttachmentsForMessage(message);
                                                if (tag.tag === "atlarix-text-attachment") {
                                                    const filename =
                                                        tag.attributes.filename || "attachment";
                                                    return (
                                                        <PastedTextAttachmentChip
                                                            key={`edit-tag-${ti}`}
                                                            content={
                                                                lookupTextPasteContent(
                                                                    filename,
                                                                    pastes,
                                                                ) || tag.content.trim()
                                                            }
                                                            displayName={filename}
                                                            readOnly
                                                        />
                                                    );
                                                }
                                                if (tag.tag === "atlarix-background-job") {
                                                    const jobId = tag.attributes.job_id || "job";
                                                    return (
                                                        <BackgroundJobAttachmentChip
                                                            key={`edit-tag-${ti}`}
                                                            displayName={`id-${jobId}`}
                                                            command={tag.attributes.command || ""}
                                                            outputTail={tag.content.trim() || undefined}
                                                            readOnly
                                                        />
                                                    );
                                                }
                                                const label =
                                                    tag.attributes.label || "Terminal output";
                                                const body = lookupTerminalPasteContent(
                                                    label,
                                                    pastes,
                                                );
                                                return (
                                                    <TerminalOutputAttachmentChip
                                                        key={`edit-tag-${ti}`}
                                                        content={body.content || tag.content.trim()}
                                                        displayContent={body.displayContent}
                                                        displayName={label}
                                                        readOnly
                                                    />
                                                );
                                            })}
                                        </div>
                                    )}
                                    <textarea
                                        value={editContent}
                                        onChange={(e) => setEditContent(e.target.value)}
                                        className="w-full min-h-[120px] rounded-md border border-border/50 bg-background/70 p-2 text-sm text-foreground"
                                        autoFocus
                                    />
                                </>
                            ) : isAssistant ? (
                                <AssistantMessageBody
                                    content={message.content ?? ""}
                                    assistantMessageId={message.id}
                                    chatId={chatId ?? message.chatId}
                                    isStreaming={isStreaming}
                                    isLatestAssistant={isLatestAssistant}
                                    contentDrivenThread={false}
                                />
                            ) : (
                                // `@file:`/`@dir:` tokens are re-emitted into the prompt on
                                // send (the server needs them for extractMentionedContext),
                                // so without this they rendered as raw text — an attachment
                                // that looked like text and could not be previewed. Split
                                // them out for DISPLAY only; message.content keeps its
                                // tokens, so editing and re-dispatch are unaffected.
                                (() => {
                                    const { text, mentions } = extractMentions(
                                        message.content ?? "",
                                    );
                                    return (
                                        <>
                                            <SentMentionChips mentions={mentions} />
                                            <UserMessageMarkdownParser
                                                content={text}
                                                pasteAttachments={(() => {
                                                    const pastes =
                                                        resolvePasteAttachmentsForMessage(message);
                                                    return pastes.length > 0 ? pastes : undefined;
                                                })()}
                                            />
                                        </>
                                    );
                                })()
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

                {/* v14.7: turn parked on a human wait (approval / ask_user) — NOT an error.
                    A neutral "waiting" affordance (the question card renders separately from
                    its artifact). Distinct from the amber "interrupted" block below. */}
                {isAssistant && message.waiting && !message.interrupted && !isStreaming && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        <span className="flex-1 min-w-[8rem]">
                            This turn is waiting for your input — send a message to continue.
                        </span>
                    </div>
                )}

                {/* Issue 4: interrupted turn — partial output preserved, offer Continue. */}
                {isAssistant && message.interrupted && !isStreaming && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1 min-w-[8rem]">
                            This response was interrupted before it finished.
                        </span>
                        {onContinue && (
                            <button
                                type="button"
                                onClick={() => onContinue(message)}
                                className="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 font-medium text-amber-800 transition-colors hover:bg-amber-500/30 dark:text-amber-200"
                            >
                                <RotateCw className="h-3 w-3" />
                                Continue
                            </button>
                        )}
                    </div>
                )}

                {/* Actions under messages — Copy / Revert turn */}
                {isAssistant && message.content && !isStreaming && (
                    <div className="flex mt-1 justify-start gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                        {resolvedWorkspaceAppId != null ? (
                            <RevertTurnAction chatId={chatId ?? undefined} messageId={message.id} />
                        ) : null}
                    </div>
                )}
                {/* Edit is allowed mid-stream: editing a user message truncates
                    and resends, which cancels the in-flight turn (see
                    performEdit). Lets users correct a prompt without the
                    stop-then-edit two-step. */}
                {isUser && (message.content || isEditing) && (
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
                                        const split = splitAttachmentTagsForEdit(message.content);
                                        setEditContent(split.text);
                                        setEditTags(split.tags);
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
                                                await onEditUserMessage?.(
                                                    message.id,
                                                    rejoinAttachmentTags(editContent, editTags),
                                                );
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
                                            setEditTags([]);
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

/**
 * Messages arrive over IPC (structured-clone) so every row gets a FRESH object
 * reference on every streaming tick — a default `memo` would never skip. This
 * content-aware comparator skips re-rendering completed rows (whose fields are
 * unchanged tick-to-tick) while always re-rendering the one whose content grew.
 * The actively-streaming row's body also subscribes to live atoms directly, so
 * it keeps updating even when the parent cascade is skipped here.
 */
function messagePropsEqual(
    prev: SimpleMessageProps,
    next: SimpleMessageProps,
): boolean {
    const a = prev.message;
    const b = next.message;
    return (
        prev.chatId === next.chatId &&
        prev.workspaceAppId === next.workspaceAppId &&
        prev.isStreaming === next.isStreaming &&
        prev.isLatestAssistant === next.isLatestAssistant &&
        prev.onEditUserMessage === next.onEditUserMessage &&
        prev.onContinue === next.onContinue &&
        a.id === b.id &&
        a.role === b.role &&
        a.content === b.content &&
        a.sessionRowId === b.sessionRowId &&
        a.interrupted === b.interrupted &&
        a.workMode === b.workMode &&
        a.displaySnapshot === b.displaySnapshot &&
        (a.sources?.length ?? 0) === (b.sources?.length ?? 0)
    );
}

export const SimpleMessage = memo(SimpleMessageImpl, messagePropsEqual);

