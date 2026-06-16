/**
 * Input Bar Component
 * ===================
 * Message input with file attachments and @ mentions
 */

import { useState, useRef, KeyboardEvent } from 'react';
import { useComposerAutocomplete } from '@/components/chat/ComposerAutocomplete';

interface InputBarProps {
    onSendMessage: (message: string, attachments?: File[]) => void;
    disabled?: boolean;
}

export function InputBar({ onSendMessage, disabled }: InputBarProps) {
    const [message, setMessage] = useState('');
    const [attachments, setAttachments] = useState<File[]>([]);
    const [showFilePickerMenu, setShowFilePickerMenu] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { menu: autocompleteMenu, onKeyDown: autocompleteKeyDown } =
        useComposerAutocomplete({ value: message, setValue: setMessage, textareaRef });

    const handleSend = () => {
        if (message.trim() || attachments.length > 0) {
            onSendMessage(message, attachments);
            setMessage('');
            setAttachments([]);
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (autocompleteKeyDown(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleFileSelect = (files: FileList | null) => {
        if (files) {
            setAttachments(prev => [...prev, ...Array.from(files)]);
        }
    };

    return (
        <div
            style={{
                borderTop: '1px solid var(--graphite-border)',
                padding: '16px 24px',
                background: 'var(--slate-charcoal)',
            }}
        >
            {/* Attachments Preview */}
            {attachments.length > 0 && (
                <AttachmentsPreview
                    attachments={attachments}
                    onRemove={index => setAttachments(prev => prev.filter((_, i) => i !== index))}
                />
            )}

            {/* Input Container */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: '12px',
                    background: 'var(--obsidian-graphite)',
                    borderRadius: '12px',
                    border: '1px solid var(--graphite-border)',
                    padding: '12px',
                    position: 'relative',
                }}
            >
                {autocompleteMenu}
                {/* Attach Button */}
                <div style={{ position: 'relative' }}>
                    <button
                        onClick={() => setShowFilePickerMenu(!showFilePickerMenu)}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '8px',
                            borderRadius: '6px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--secondary-text)',
                            transition: 'all 0.2s',
                        }}
                        onMouseEnter={e => {
                            e.currentTarget.style.background = 'var(--graphite-hover)';
                            e.currentTarget.style.color = 'var(--teal-glow)';
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.color = 'var(--secondary-text)';
                        }}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                        </svg>
                    </button>

                    {/* File Picker Menu */}
                    {showFilePickerMenu && (
                        <div
                            style={{
                                position: 'absolute',
                                bottom: '100%',
                                left: 0,
                                marginBottom: '8px',
                                background: 'var(--slate-charcoal)',
                                border: '1px solid var(--graphite-border)',
                                borderRadius: '8px',
                                padding: '8px',
                                minWidth: '200px',
                                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                                zIndex: 100,
                            }}
                        >
                            <FilePickerOption
                                label="From Workspace"
                                symbol="▣"
                                onClick={() => {
                                    // Open workspace file picker
                                    fileInputRef.current?.click();
                                    setShowFilePickerMenu(false);
                                }}
                            />
                            <FilePickerOption
                                label="From Computer"
                                symbol="▢"
                                onClick={() => {
                                    fileInputRef.current?.click();
                                    setShowFilePickerMenu(false);
                                }}
                            />
                        </div>
                    )}

                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        onChange={e => handleFileSelect(e.target.files)}
                    />
                </div>

                {/* Textarea */}
                <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask Atlarix anything..."
                    disabled={disabled}
                    style={{
                        flex: 1,
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        color: 'var(--primary-text)',
                        fontSize: '14px',
                        resize: 'none',
                        maxHeight: '120px',
                        lineHeight: '1.5',
                        fontFamily: 'inherit',
                    }}
                    rows={1}
                    onInput={e => {
                        const target = e.target as HTMLTextAreaElement;
                        target.style.height = 'auto';
                        target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
                    }}
                />

                {/* Send Button */}
                <button
                    onClick={handleSend}
                    disabled={disabled || (!message.trim() && attachments.length === 0)}
                    style={{
                        background: message.trim() || attachments.length > 0 ? 'var(--teal-glow)' : 'var(--graphite-hover)',
                        border: 'none',
                        borderRadius: '8px',
                        padding: '8px 12px',
                        cursor: message.trim() || attachments.length > 0 ? 'pointer' : 'not-allowed',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        opacity: disabled ? 0.5 : 1,
                    }}
                >
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={message.trim() || attachments.length > 0 ? 'var(--obsidian-graphite)' : 'var(--secondary-text)'}
                        strokeWidth="2"
                    >
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                </button>
            </div>

            {/* Hint Text */}
            <div
                style={{
                    marginTop: '8px',
                    fontSize: '12px',
                    color: 'var(--secondary-text)',
                    textAlign: 'center',
                }}
            >
                Press Enter to send • Shift+Enter for new line • @ to attach files
            </div>
        </div>
    );
}

function FilePickerOption({
    label,
    symbol,
    onClick,
}: {
    label: string;
    symbol: string;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            style={{
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                color: 'var(--primary-text)',
                fontSize: '13px',
                transition: 'background 0.2s',
            }}
            onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--graphite-hover)';
            }}
            onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
            }}
        >
            <span style={{ color: 'var(--teal-glow)', fontSize: '16px' }}>{symbol}</span>
            <span>{label}</span>
        </button>
    );
}

function AttachmentsPreview({
    attachments,
    onRemove,
}: {
    attachments: File[];
    onRemove: (index: number) => void;
}) {
    return (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            {attachments.map((file, index) => (
                <div
                    key={index}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 10px',
                        background: 'var(--graphite-hover)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        color: 'var(--primary-text)',
                    }}
                >
                    <span>▣</span>
                    <span>{file.name}</span>
                    <button
                        onClick={() => onRemove(index)}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--secondary-text)',
                            cursor: 'pointer',
                            padding: '0 4px',
                            fontSize: '14px',
                        }}
                    >
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}
