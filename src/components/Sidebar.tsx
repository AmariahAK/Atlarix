/**
 * Sidebar Navigation Component
 * ============================
 * Modified sidebar with Help, Diagram, Web sections and OAuth login
 */

import React, { useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/lib/auth/useAuth';
import { LogIn, LogOut, User, Github, Chrome } from 'lucide-react';

type SidebarTab = 'help' | 'diagram' | 'web';

interface SidebarProps {
    activeTab: SidebarTab;
    onTabChange: (tab: SidebarTab) => void;
}

export function Sidebar({ activeTab, onTabChange }: SidebarProps) {
    const { user, isAuthenticated, signInWithGoogle, signInWithGitHub, signOut, status } = useAuth();
    const [showAuthMenu, setShowAuthMenu] = useState(false);

    const tabs: Array<{ id: SidebarTab; label: string; symbol: string }> = [
        { id: 'help', label: 'Help', symbol: '?' },
        { id: 'diagram', label: 'Diagram', symbol: '◈' },
        { id: 'web', label: 'Web', symbol: '⊕' },
    ];

    return (
        <div
            className="sidebar"
            style={{
                width: '240px',
                background: 'var(--slate-charcoal)',
                borderRight: '1px solid var(--graphite-border)',
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                position: 'relative',
            }}
        >
            {/* Tab Navigation */}
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                {tabs.map(tab => (
                    <SidebarTab
                        key={tab.id}
                        symbol={tab.symbol}
                        label={tab.label}
                        active={activeTab === tab.id}
                        onClick={() => onTabChange(tab.id)}
                    />
                ))}
            </div>

            {/* OAuth Login Section */}
            <div
                style={{
                    borderTop: '1px solid var(--graphite-border)',
                    padding: '12px',
                }}
            >
                {isAuthenticated && user ? (
                    // Logged in state
                    <div
                        onClick={() => setShowAuthMenu(!showAuthMenu)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            padding: '10px',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            background: showAuthMenu ? 'var(--graphite-hover)' : 'transparent',
                            transition: 'background 0.2s ease',
                        }}
                        onMouseEnter={e => {
                            if (!showAuthMenu) e.currentTarget.style.background = 'var(--graphite-hover)';
                        }}
                        onMouseLeave={e => {
                            if (!showAuthMenu) e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        {user.avatar ? (
                            <img
                                src={user.avatar}
                                alt={user.name}
                                style={{
                                    width: '32px',
                                    height: '32px',
                                    borderRadius: '50%',
                                    border: '2px solid var(--teal-glow)',
                                }}
                            />
                        ) : (
                            <div
                                style={{
                                    width: '32px',
                                    height: '32px',
                                    borderRadius: '50%',
                                    background: 'linear-gradient(135deg, var(--teal-glow), var(--aurora-purple))',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'white',
                                    fontWeight: 600,
                                    fontSize: '14px',
                                }}
                            >
                                {user.name?.charAt(0)?.toUpperCase() || 'U'}
                            </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                                fontSize: '13px',
                                fontWeight: 600,
                                color: 'var(--primary-text)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}>
                                {user.name}
                            </div>
                            <div style={{
                                fontSize: '11px',
                                color: 'var(--secondary-text)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                            }}>
                                <span style={{
                                    padding: '1px 6px',
                                    borderRadius: '4px',
                                    background: status?.plan === 'free' ? 'var(--graphite-hover)' : 'var(--teal-glow)',
                                    color: status?.plan === 'free' ? 'var(--secondary-text)' : 'white',
                                    fontSize: '10px',
                                    fontWeight: 500,
                                }}>
                                    {status?.plan === 'free' ? 'Free' : 'Pro'}
                                </span>
                            </div>
                        </div>
                    </div>
                ) : (
                    // Logged out state - show login buttons
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{
                            fontSize: '12px',
                            color: 'var(--secondary-text)',
                            marginBottom: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                        }}>
                            <LogIn size={14} />
                            <span>Sign in to sync</span>
                        </div>
                        <button
                            onClick={signInWithGoogle}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '8px 12px',
                                borderRadius: '6px',
                                border: '1px solid var(--graphite-border)',
                                background: 'var(--graphite-hover)',
                                color: 'var(--primary-text)',
                                cursor: 'pointer',
                                fontSize: '13px',
                                fontWeight: 500,
                                transition: 'all 0.2s ease',
                            }}
                            onMouseEnter={e => {
                                e.currentTarget.style.borderColor = 'var(--teal-glow)';
                                e.currentTarget.style.background = 'var(--slate-charcoal)';
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.borderColor = 'var(--graphite-border)';
                                e.currentTarget.style.background = 'var(--graphite-hover)';
                            }}
                        >
                            <Chrome size={16} />
                            <span>Google</span>
                        </button>
                        <button
                            onClick={signInWithGitHub}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '8px 12px',
                                borderRadius: '6px',
                                border: '1px solid var(--graphite-border)',
                                background: 'var(--graphite-hover)',
                                color: 'var(--primary-text)',
                                cursor: 'pointer',
                                fontSize: '13px',
                                fontWeight: 500,
                                transition: 'all 0.2s ease',
                            }}
                            onMouseEnter={e => {
                                e.currentTarget.style.borderColor = 'var(--aurora-purple)';
                                e.currentTarget.style.background = 'var(--slate-charcoal)';
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.borderColor = 'var(--graphite-border)';
                                e.currentTarget.style.background = 'var(--graphite-hover)';
                            }}
                        >
                            <Github size={16} />
                            <span>GitHub</span>
                        </button>
                    </div>
                )}

                {/* Auth Menu Dropdown */}
                {showAuthMenu && isAuthenticated && (
                    <div
                        style={{
                            marginTop: '8px',
                            padding: '8px',
                            borderRadius: '8px',
                            background: 'var(--graphite-hover)',
                            border: '1px solid var(--graphite-border)',
                        }}
                    >
                        <button
                            onClick={() => {
                                signOut();
                                setShowAuthMenu(false);
                            }}
                            style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '8px 10px',
                                borderRadius: '6px',
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--error-red, #ef4444)',
                                cursor: 'pointer',
                                fontSize: '13px',
                                fontWeight: 500,
                                transition: 'background 0.2s ease',
                            }}
                            onMouseEnter={e => {
                                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.background = 'transparent';
                            }}
                        >
                            <LogOut size={16} />
                            <span>Sign Out</span>
                        </button>
                    </div>
                )}
            </div>

            {/* Resize Handle */}
            <div
                className="resize-handle"
                style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: '4px',
                    cursor: 'ew-resize',
                    background: 'transparent',
                }}
                onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--teal-glow)';
                }}
                onMouseLeave={e => {
                    e.currentTarget.style.background = 'transparent';
                }}
            />
        </div>
    );
}

interface SidebarTabProps {
    symbol: string;
    label: string;
    active: boolean;
    onClick: () => void;
}

function SidebarTab({ symbol, label, active, onClick }: SidebarTabProps) {
    const [isHovered, setIsHovered] = useState(false);

    return (
        <div
            onClick={onClick}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                cursor: 'pointer',
                background: active ? 'var(--graphite-hover)' : isHovered ? 'var(--graphite-hover)' : 'transparent',
                borderLeft: active ? '3px solid var(--teal-glow)' : '3px solid transparent',
                color: active ? 'var(--primary-text)' : 'var(--secondary-text)',
                transition: 'all 0.2s ease',
                userSelect: 'none',
            }}
        >
            {/* Symbol */}
            <span
                style={{
                    fontSize: '20px',
                    fontWeight: 600,
                    color: active ? 'var(--teal-glow)' : 'var(--secondary-text)',
                }}
            >
                {symbol}
            </span>

            {/* Label */}
            <span
                style={{
                    fontSize: '14px',
                    fontWeight: active ? 600 : 500,
                }}
            >
                {label}
            </span>
        </div>
    );
}

// Content panels for each tab
export function HelpPanel() {
    const capabilities = [
        {
            title: 'Code Understanding',
            desc: 'Analyze codebases, extract structure, find dependencies',
        },
        {
            title: 'Smart Search',
            desc: 'Semantic search, multi-source synthesis, web integration',
        },
        {
            title: 'Code Generation',
            desc: 'Templates, scaffolding, refactoring, batch modifications',
        },
        {
            title: 'Visualization',
            desc: 'Auto-generate architecture and class diagrams',
        },
        {
            title: 'Testing & Preview',
            desc: 'Run tests, start dev servers, live preview',
        },
        {
            title: 'Version Control',
            desc: 'Git status, diffs, branch management',
        },
    ];

    return (
        <div style={{ padding: '24px', color: 'var(--primary-text)' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
                Atlarix Capabilities
            </h2>
            <p style={{ color: 'var(--secondary-text)', marginBottom: '24px', fontSize: '14px' }}>
                Your AI development partner with 41 powerful tools
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {capabilities.map((cap, index) => (
                    <div
                        key={index}
                        style={{
                            padding: '12px',
                            background: 'var(--graphite-hover)',
                            borderRadius: '8px',
                            borderLeft: '3px solid var(--teal-glow)',
                        }}
                    >
                        <div style={{ fontWeight: 600, marginBottom: '4px' }}>{cap.title}</div>
                        <div style={{ fontSize: '13px', color: 'var(--secondary-text)' }}>
                            {cap.desc}
                        </div>
                    </div>
                ))}
            </div>

            <div
                style={{
                    marginTop: '24px',
                    padding: '16px',
                    background: 'var(--graphite-hover)',
                    borderRadius: '8px',
                    border: '1px solid var(--teal-glow)',
                }}
            >
                <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
                    💡 Pro Tip
                </div>
                <div style={{ fontSize: '13px', color: 'var(--secondary-text)' }}>
                    Use @ to attach files from your workspace or computer. Atlarix will analyze them in context.
                </div>
            </div>
        </div>
    );
}

export function DiagramPanel() {
    return (
        <div style={{ padding: '24px', color: 'var(--primary-text)' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
                Project Diagrams
            </h2>
            <p style={{ color: 'var(--secondary-text)', marginBottom: '24px', fontSize: '14px' }}>
                Visual representation of your workspace architecture
            </p>

            <div
                style={{
                    padding: '16px',
                    background: 'var(--graphite-hover)',
                    borderRadius: '8px',
                    textAlign: 'center',
                }}
            >
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>◈</div>
                <div style={{ fontSize: '14px', color: 'var(--secondary-text)' }}>
                    No workspace selected
                </div>
                <div style={{ fontSize: '13px', color: 'var(--secondary-text)', marginTop: '4px' }}>
                    Open a project to generate diagrams
                </div>
            </div>
        </div>
    );
}

export function WebPanel() {
    return (
        <div style={{ padding: '24px', color: 'var(--primary-text)' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
                Web Search History
            </h2>
            <p style={{ color: 'var(--secondary-text)', marginBottom: '24px', fontSize: '14px' }}>
                Recent web searches and resources
            </p>

            <div
                style={{
                    padding: '16px',
                    background: 'var(--graphite-hover)',
                    borderRadius: '8px',
                    textAlign: 'center',
                }}
            >
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>⊕</div>
                <div style={{ fontSize: '14px', color: 'var(--secondary-text)' }}>
                    No searches yet
                </div>
                <div style={{ fontSize: '13px', color: 'var(--secondary-text)', marginTop: '4px' }}>
                    Ask Atlarix to search the web
                </div>
            </div>
        </div>
    );
}
