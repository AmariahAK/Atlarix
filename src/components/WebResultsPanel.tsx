/**
 * Web Search Results Panel
 * ========================
 * Display web search results with clickable links
 */

import React from 'react';

interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
    favicon?: string;
}

interface WebResultsPanelProps {
    query: string;
    results: WebSearchResult[];
    onReadPage?: (url: string) => void;
}

export function WebResultsPanel({ query, results, onReadPage }: WebResultsPanelProps) {
    return (
        <div
            style={{
                background: 'var(--slate-charcoal)',
                border: '1px solid var(--graphite-border)',
                borderRadius: '12px',
                padding: '16px',
                marginTop: '12px',
            }}
        >
            {/* Header */}
            <div style={{ marginBottom: '16px' }}>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '8px',
                    }}
                >
                    <span style={{ fontSize: '20px' }}>⊕</span>
                    <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--primary-text)' }}>
                        Web Search Results
                    </span>
                </div>
                <div style={{ fontSize: '14px', color: 'var(--secondary-text)' }}>
                    Query: "{query}" • Found {results.length} results
                </div>
            </div>

            {/* Results List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {results.map((result, index) => (
                    <WebResultCard key={index} result={result} onReadPage={onReadPage} />
                ))}
            </div>
        </div>
    );
}

function WebResultCard({
    result,
    onReadPage,
}: {
    result: WebSearchResult;
    onReadPage?: (url: string) => void;
}) {
    return (
        <div
            style={{
                padding: '12px',
                background: 'var(--graphite-hover)',
                borderRadius: '8px',
                border: '1px solid var(--graphite-border)',
                transition: 'all 0.2s',
                cursor: 'pointer',
            }}
            onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--teal-glow)';
                e.currentTarget.style.background = 'var(--obsidian-graphite)';
            }}
            onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--graphite-border)';
                e.currentTarget.style.background = 'var(--graphite-hover)';
            }}
        >
            {/* Title */}
            <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                    fontSize: '15px',
                    fontWeight: 600,
                    color: 'var(--teal-glow)',
                    textDecoration: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '6px',
                }}
            >
                {result.favicon && (
                    <img
                        src={result.favicon}
                        alt=""
                        style={{ width: '16px', height: '16px', borderRadius: '2px' }}
                    />
                )}
                <span>{result.title}</span>
            </a>

            {/* URL */}
            <div
                style={{
                    fontSize: '12px',
                    color: 'var(--secondary-text)',
                    marginBottom: '8px',
                    fontFamily: 'monospace',
                }}
            >
                {new URL(result.url).hostname}
            </div>

            {/* Snippet */}
            <div
                style={{
                    fontSize: '13px',
                    color: 'var(--primary-text)',
                    lineHeight: '1.5',
                    marginBottom: '8px',
                }}
            >
                {result.snippet}
            </div>

            {/* Read Full Page Button */}
            {onReadPage && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onReadPage(result.url);
                    }}
                    style={{
                        padding: '6px 12px',
                        background: 'transparent',
                        border: '1px solid var(--teal-glow)',
                        borderRadius: '6px',
                        color: 'var(--teal-glow)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        fontWeight: 500,
                    }}
                >
                    Read Full Page ↗
                </button>
            )}
        </div>
    );
}
