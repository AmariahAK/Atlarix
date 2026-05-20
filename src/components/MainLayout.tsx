/**
 * Main App Layout
 * ===============
 * Combines all UI components into the main application layout
 */

import React, { useState } from 'react';
import { TitleBar } from '@/components/TitleBar';
import { Sidebar, HelpPanel, WebPanel } from '@/components/Sidebar';
import { ChatInterface } from '@/components/ChatInterface';
import { InputBar } from '@/components/InputBar';

type SidebarTab = 'help' | 'web';

export function MainLayout() {
    const [sidebarTab, setSidebarTab] = useState<SidebarTab>('help');
    const [messages, setMessages] = useState<any[]>([]);
    const [isThinking, setIsThinking] = useState(false);

    const handleSendMessage = async (message: string, attachments?: File[]) => {
        // Add user message
        const userMessage = {
            id: Date.now().toString(),
            role: 'user' as const,
            content: message,
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setIsThinking(true);

        // TODO: Send to AI backend
        // Simulate AI response
        setTimeout(() => {
            const aiMessage = {
                id: (Date.now() + 1).toString(),
                role: 'assistant' as const,
                content: 'I received your message! This is a placeholder response.',
                timestamp: new Date(),
                toolCalls: [],
            };

            setMessages(prev => [...prev, aiMessage]);
            setIsThinking(false);
        }, 2000);
    };

    const handleMinimize = () => {
        if (window.electron) {
            window.electron.minimize();
        }
    };

    const handleMaximize = () => {
        if (window.electron) {
            window.electron.maximize();
        }
    };

    const handleClose = () => {
        if (window.electron) {
            window.electron.close();
        }
    };

    return (
        <div className="app-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            {/* Title Bar */}
            <TitleBar onMinimize={handleMinimize} onMaximize={handleMaximize} onClose={handleClose} />

            {/* Main Content Area */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* Sidebar */}
                <Sidebar activeTab={sidebarTab} onTabChange={setSidebarTab} />

                {/* Sidebar Content */}
                <div
                    style={{
                        width: '300px',
                        background: 'var(--slate-charcoal)',
                        borderRight: '1px solid var(--graphite-border)',
                        overflowY: 'auto',
                    }}
                >
                    {sidebarTab === 'help' && <HelpPanel />}
                    {sidebarTab === 'web' && <WebPanel />}
                </div>

                {/* Chat Area */}
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <ChatInterface messages={messages} isThinking={isThinking} />
                    <InputBar onSendMessage={handleSendMessage} disabled={isThinking} />
                </div>
            </div>
        </div>
    );
}
