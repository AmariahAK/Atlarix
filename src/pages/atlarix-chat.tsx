/**
 * Integrated Atlarix Chat Page
 * ============================
 * New integrated chat with AI and tools
 */

import React, { useState, useEffect } from 'react';
import { ChatHandler } from '@/lib/chat-handler';
import { useAtlarixStore } from '@/lib/store';
import type { Message } from '@/types';
import { TitleBar } from '@/components/TitleBar';
import { Sidebar, HelpPanel, DiagramPanel, WebPanel } from '@/components/Sidebar';
import { ChatInterface } from '@/components/ChatInterface';
import { InputBar } from '@/components/InputBar';

type SidebarTab = 'help' | 'diagram' | 'web';

export default function AtlarixChat() {
    const [chatHandler] = useState(() => new ChatHandler());
    const [messages, setMessages] = useState<Message[]>([]);
    const [isThinking, setIsThinking] = useState(false);
    const [sidebarTab, setSidebarTab] = useState<SidebarTab>('help');
    const { setAvailableModels, setCurrentModel } = useAtlarixStore();

    // Initialize providers
    useEffect(() => {
        const initProviders = async () => {
            const providers = chatHandler.getProviders();
            const models = providers.map((p: any) => ({
                id: p.id,
                name: p.name,
                provider: p.type as any,
                status: 'connected' as const,
            }));

            setAvailableModels(models);
            if (models.length > 0) {
                setCurrentModel(models[0]);
            }
        };

        initProviders();
    }, []);

    const handleSendMessage = async (message: string, attachments?: File[]) => {
        setIsThinking(true);

        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: message,
            timestamp: new Date(),
        };

        setMessages((prev) => [...prev, userMessage]);

        const assistantMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: '',
            toolCalls: [],
            timestamp: new Date(),
        };

        setMessages((prev) => [...prev, assistantMessage]);

        try {
            await chatHandler.sendMessage(
                message,
                attachments,
                (updatedMsg) => {
                    setMessages((prev) => {
                        const newMessages = [...prev];
                        const index = newMessages.findIndex((m) => m.id === updatedMsg.id);
                        if (index !== -1) {
                            newMessages[index] = updatedMsg;
                        }
                        return newMessages;
                    });
                },
                (toolCall) => {
                    setMessages((prev) => {
                        const newMessages = [...prev];
                        const msgIndex = newMessages.findIndex((m) => m.id === assistantMessage.id);
                        if (msgIndex !== -1) {
                            const msg = newMessages[msgIndex];
                            const toolIndex = msg.toolCalls?.findIndex((t) => t.id === toolCall.id);

                            if (toolIndex !== undefined && toolIndex !== -1 && msg.toolCalls) {
                                msg.toolCalls[toolIndex] = toolCall;
                            } else {
                                msg.toolCalls = [...(msg.toolCalls || []), toolCall];
                            }
                        }
                        return newMessages;
                    });
                }
            );
        } catch (error) {
            console.error('Chat error:', error);
            setMessages((prev) => {
                const newMessages = [...prev];
                const index = newMessages.findIndex((m) => m.id === assistantMessage.id);
                if (index !== -1) {
                    newMessages[index].content = `Error: ${error instanceof Error ? error.message : 'Unknown error'
                        }`;
                }
                return newMessages;
            });
        } finally {
            setIsThinking(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <TitleBar />

            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                <Sidebar activeTab={sidebarTab} onTabChange={setSidebarTab} />

                <div
                    style={{
                        width: '300px',
                        background: 'var(--slate-charcoal)',
                        borderRight: '1px solid var(--graphite-border)',
                        overflowY: 'auto',
                    }}
                >
                    {sidebarTab === 'help' && <HelpPanel />}
                    {sidebarTab === 'diagram' && <DiagramPanel />}
                    {sidebarTab === 'web' && <WebPanel />}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <ChatInterface messages={messages} isThinking={isThinking} />
                    <InputBar onSendMessage={handleSendMessage} disabled={isThinking} />
                </div>
            </div>
        </div>
    );
}
