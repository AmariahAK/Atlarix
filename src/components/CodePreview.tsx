/**
 * Code Preview Panel
 * ==================
 * Syntax-highlighted code preview with copy button
 */

import React, { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface CodePreviewProps {
    code: string;
    language: string;
    filename?: string;
    showLineNumbers?: boolean;
}

export function CodePreview({
    code,
    language,
    filename,
    showLineNumbers = true,
}: CodePreviewProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div
            style={{
                background: 'var(--slate-charcoal)',
                border: '1px solid var(--graphite-border)',
                borderRadius: '12px',
                overflow: 'hidden',
                marginTop: '12px',
            }}
        >
            {/* Header */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    background: 'var(--obsidian-graphite)',
                    borderBottom: '1px solid var(--graphite-border)',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '18px' }}>▣</span>
                    <span
                        style={{
                            fontSize: '14px',
                            fontWeight: 500,
                            color: 'var(--primary-text)',
                            fontFamily: 'monospace',
                        }}
                    >
                        {filename || `${language} code`}
                    </span>
                    <span
                        style={{
                            fontSize: '11px',
                            color: 'var(--secondary-text)',
                            textTransform: 'uppercase',
                            background: 'var(--graphite-hover)',
                            padding: '2px 6px',
                            borderRadius: '4px',
                        }}
                    >
                        {language}
                    </span>
                </div>

                {/* Copy Button */}
                <button
                    onClick={handleCopy}
                    style={{
                        padding: '6px 12px',
                        background: copied ? 'var(--teal-glow)' : 'var(--graphite-hover)',
                        border: '1px solid',
                        borderColor: copied ? 'var(--teal-glow)' : 'var(--graphite-border)',
                        borderRadius: '6px',
                        color: copied ? 'var(--obsidian-graphite)' : 'var(--primary-text)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'all 0.2s',
                    }}
                >
                    {copied ? (
                        <>
                            <span>✓</span>
                            <span>Copied!</span>
                        </>
                    ) : (
                        <>
                            <span>▢</span>
                            <span>Copy</span>
                        </>
                    )}
                </button>
            </div>

            {/* Code */}
            <div style={{ maxHeight: '400px', overflow: 'auto' }}>
                <SyntaxHighlighter
                    language={language}
                    style={vscDarkPlus}
                    showLineNumbers={showLineNumbers}
                    customStyle={{
                        margin: 0,
                        background: 'var(--obsidian-graphite)',
                        fontSize: '13px',
                        padding: '16px',
                    }}
                    lineNumberStyle={{
                        color: 'var(--secondary-text)',
                        minWidth: '3em',
                    }}
                >
                    {code}
                </SyntaxHighlighter>
            </div>
        </div>
    );
}

// Multi-file code preview
interface FilePreview {
    filename: string;
    code: string;
    language: string;
}

interface MultiFilePreviewProps {
    files: FilePreview[];
    title?: string;
}

export function MultiFilePreview({ files, title }: MultiFilePreviewProps) {
    const [activeFileIndex, setActiveFileIndex] = useState(0);

    return (
        <div
            style={{
                background: 'var(--slate-charcoal)',
                border: '1px solid var(--graphite-border)',
                borderRadius: '12px',
                overflow: 'hidden',
                marginTop: '12px',
            }}
        >
            {/* Header with Title */}
            {title && (
                <div
                    style={{
                        padding: '12px 16px',
                        background: 'var(--obsidian-graphite)',
                        borderBottom: '1px solid var(--graphite-border)',
                        fontSize: '16px',
                        fontWeight: 600,
                        color: 'var(--primary-text)',
                    }}
                >
                    {title}
                </div>
            )}

            {/* File Tabs */}
            <div
                style={{
                    display: 'flex',
                    gap: '4px',
                    padding: '8px',
                    background: 'var(--graphite-hover)',
                    borderBottom: '1px solid var(--graphite-border)',
                    overflowX: 'auto',
                }}
            >
                {files.map((file, index) => (
                    <button
                        key={index}
                        onClick={() => setActiveFileIndex(index)}
                        style={{
                            padding: '8px 12px',
                            background:
                                activeFileIndex === index ? 'var(--obsidian-graphite)' : 'transparent',
                            border: '1px solid',
                            borderColor:
                                activeFileIndex === index ? 'var(--teal-glow)' : 'transparent',
                            borderRadius: '6px',
                            color:
                                activeFileIndex === index ? 'var(--primary-text)' : 'var(--secondary-text)',
                            fontSize: '13px',
                            cursor: 'pointer',
                            fontFamily: 'monospace',
                            whiteSpace: 'nowrap',
                            transition: 'all 0.2s',
                        }}
                    >
                        {file.filename}
                    </button>
                ))}
            </div>

            {/* Active File Content */}
            <CodePreview
                code={files[activeFileIndex].code}
                language={files[activeFileIndex].language}
                filename={files[activeFileIndex].filename}
            />
        </div>
    );
}
