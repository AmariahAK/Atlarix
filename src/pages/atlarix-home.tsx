/**
 * Atlarix Home Page
 * Custom branded home page with Atlarix UI theming
 * Updated: 2025-12-25 - Added 3-panel layout with RightPanel
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { homeChatInputValueAtom, activeChatIdAtom } from '../atoms/chatAtoms';
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from '@/atoms/appAtoms';
import { IpcClient } from '@/ipc/ipc_client';
import { generateCuteAppName } from '@/lib/utils';
import { useLoadApps } from '@/hooks/useLoadApps';
import { useSettings } from '@/hooks/useSettings';
import { SetupBanner } from '@/components/SetupBanner';
import { isPreviewOpenAtom } from '@/atoms/viewAtoms';
import { useStreamChat } from '@/hooks/useStreamChat';
import { usePostHog } from 'posthog-js/react';
import { PrivacyBanner } from '@/components/TelemetryBanner';
import { Template } from '@/shared/templates';
import { useTheme } from '@/contexts/ThemeContext';
import { showError } from '@/lib/toast';
import { invalidateAppQuery } from '@/hooks/useLoadApp';
import { useQueryClient } from '@tanstack/react-query';
import { ForceCloseDialog } from '@/components/ForceCloseDialog';
import { ProBanner } from '@/components/ProBanner';
import type { FileAttachment } from '@/ipc/ipc_types';
import { NEON_TEMPLATE_IDS } from '@/shared/templates';
import { neonTemplateHook } from '@/client_logic/template_hook';
import { HomeChatInput } from '@/components/chat/HomeChatInput';
import { useAuth } from '@/lib/auth/useAuth';
import { SimpleInlineChat } from '@/components/SimpleInlineChat';
import { RightPanel } from '@/components/RightPanel';
import { rightPanelVisibleAtom, rightPanelSuppressAutoOpenAtom, sourceListAtom, selectedSourceAtom } from '@/atoms/sourceAtoms';
import { onboardingStepAtom } from '@/atoms/viewAtoms';
import { persistOnboardingStep } from '@/lib/onboarding';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { Button } from '@/components/ui/button';
import AtlarixAnimation from '@/components/atlarix/AtlarixAnimation';
// Current datetime for AI context
const getCurrentDateTime = () => {
    return new Date().toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
    });
};

export interface HomeSubmitOptions {
    attachments?: FileAttachment[];
}

/**
 * IncognitoIndicator - Shows incognito status and global prompt indicator
 */
function IncognitoIndicator() {
    const [hasGlobalPrompt, setHasGlobalPrompt] = useState(false);

    useEffect(() => {
        const checkGlobalPrompt = async () => {
            try {
                const prompt = await IpcClient.getInstance().getGlobalPrompt();
                setHasGlobalPrompt(!!prompt);
            } catch (error) {
                console.error('Failed to check global prompt:', error);
            }
        };
        checkGlobalPrompt();
    }, []);

    return (
        <span className="text-xs text-muted-foreground italic">
            Incognito chats{hasGlobalPrompt && ' • Using global prompt'}
        </span>
    );
}

export default function AtlarixHome() {
    const [inputValue, setInputValue] = useAtom(homeChatInputValueAtom);
    const navigate = useNavigate();
    const [selectedAppId, setSelectedAppId] = useAtom(selectedAppIdAtom);
    const selectedWorkspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
    const { apps, refreshApps } = useLoadApps();
    const { settings, updateSettings } = useSettings();
    const setIsPreviewOpen = useSetAtom(isPreviewOpenAtom);
    const [isLoading, setIsLoading] = useState(false);
    const [forceCloseDialogOpen, setForceCloseDialogOpen] = useState(false);
    const [performanceData, setPerformanceData] = useState<any>(undefined);
    const [activeChatId, setActiveChatId] = useAtom(activeChatIdAtom); // Persists across navigation
    const { streamMessage } = useStreamChat({ hasChatId: false });
    const posthog = usePostHog();
    const { isDarkMode } = useTheme();
    const queryClient = useQueryClient();
    const [currentTime, setCurrentTime] = useState(getCurrentDateTime());
    const setSourceList = useSetAtom(sourceListAtom);
    const setSelectedSource = useSetAtom(selectedSourceAtom);
    const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
    const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
    const onboardingStep = useAtomValue(onboardingStepAtom);
    const setOnboardingStep = useSetAtom(onboardingStepAtom);
    const { isAuthenticated, loading: authLoading } = useAuth();
    const mustSignIn = !authLoading && !isAuthenticated;

    // Clear sources when starting a new chat
    const handleNewChat = useCallback(() => {
        setActiveChatId(null);
        setSourceList([]); // Clear stale sources
        setSelectedSource(null); // Clear selected source
        setSuppressRightAutoOpen(true);
        setRightPanelVisible(false); // Hide panel
    }, [setSourceList, setSelectedSource, setSuppressRightAutoOpen, setRightPanelVisible]);

    // Enable keyboard shortcuts (CMD+B toggle, ESC close, etc.)
    useKeyboardShortcuts();

    // Template state - fetch from API
    const [allTemplates, setAllTemplates] = useState<Template[]>([]);
    const [displayedTemplates, setDisplayedTemplates] = useState<Template[]>([]);
    const [templatesLoading, setTemplatesLoading] = useState(true);
    const [showSearchDialog, setShowSearchDialog] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Template[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [remindBannerDismissed, setRemindBannerDismissed] = useState(false);

    // Update time every minute for AI context
    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentTime(getCurrentDateTime());
        }, 60000);
        return () => clearInterval(interval);
    }, []);

    // Fetch templates from API
    useEffect(() => {
        const fetchTemplates = async () => {
            try {
                setTemplatesLoading(true);
                const templates = await IpcClient.getInstance().listTemplates();
                // Templates loaded successfully
                setAllTemplates(templates);
                // Show first 3 templates
                setDisplayedTemplates(templates.slice(0, 3));
            } catch (error) {
                console.error('[Atlarix Home] Failed to fetch templates:', error);
                setAllTemplates([]);
                setDisplayedTemplates([]);
            } finally {
                setTemplatesLoading(false);
            }
        };
        fetchTemplates();
    }, []);

    // Listen for force-close events
    useEffect(() => {
        const ipc = IpcClient.getInstance();
        const unsubscribe = ipc.onForceCloseDetected((data) => {
            setPerformanceData(data.performanceData);
            setForceCloseDialogOpen(true);
        });
        return () => unsubscribe();
    }, []);

    // Function to get random templates
    const getRandomTemplates = useCallback(() => {
        if (allTemplates.length === 0) return [];
        const shuffled = [...allTemplates].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, 3);
    }, [allTemplates]);

    // Rotate to new random templates
    const handleMoreIdeas = () => {
        setDisplayedTemplates(getRandomTemplates());
    };

    // Live GitHub search for templates not in cache
    const handleTemplateSearch = useCallback(async (query: string) => {
        setSearchQuery(query);

        if (!query.trim()) {
            setSearchResults(allTemplates);
            return;
        }

        // First, search in cached templates
        const search = query.toLowerCase();
        const cachedMatches = allTemplates.filter(t =>
            t.title.toLowerCase().includes(search) ||
            t.description.toLowerCase().includes(search) ||
            t.techStack?.some(tech => tech.toLowerCase().includes(search))
        );

        // If we have enough cached matches, use them
        if (cachedMatches.length >= 5) {
            setSearchResults(cachedMatches);
            return;
        }

        // Otherwise, do a live GitHub search
        setIsSearching(true);
        try {
            const response = await fetch(
                `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+template+stars:>50&sort=stars&per_page=15`,
                { headers: { 'Accept': 'application/vnd.github.v3+json' } }
            );

            if (response.ok) {
                const data = await response.json();
                const liveTemplates: Template[] = data.items.map((item: any) => ({
                    id: item.full_name,
                    title: item.name,
                    description: item.description || 'No description',
                    // GitHub OpenGraph endpoint is rate-limited (429). Use owner avatar instead.
                    imageUrl: `https://github.com/${item.owner?.login ?? item.full_name.split('/')[0]}.png?size=200`,
                    githubUrl: item.html_url,
                    techStack: item.topics?.slice(0, 4) || [],
                    stars: item.stargazers_count,
                    isOfficial: false,
                }));

                // Combine cached matches with live results (deduplicate)
                const seen = new Set(cachedMatches.map(t => t.githubUrl));
                const combined = [...cachedMatches, ...liveTemplates.filter(t => !seen.has(t.githubUrl))];
                setSearchResults(combined);
            } else {
                setSearchResults(cachedMatches);
            }
        } catch (error) {
            console.error('[Atlarix Home] Live search failed:', error);
            setSearchResults(cachedMatches);
        } finally {
            setIsSearching(false);
        }
    }, [allTemplates]);

    const handleSubmit = async (options?: HomeSubmitOptions) => {
        const attachments = options?.attachments || [];

        if (!inputValue.trim() && attachments.length === 0) return;
        if (mustSignIn) {
            showError('Please sign in to use chat.');
            return;
        }

        try {
            let chatId: number;

            // If an app/workspace is selected, verify path still exists before creating chat
            if (selectedAppId) {
                const app = await IpcClient.getInstance().getApp(selectedAppId);
                if (app.pathExists === false) {
                    showError('Workspace folder not found. It may have been moved or deleted. Remove it from the list and try again.');
                    return;
                }
                // Workspace-bound chat - persisted to DB
                chatId = await IpcClient.getInstance().createChat(selectedAppId);
                console.log(`Created workspace chat ${chatId} for app ${selectedAppId}`);
            } else {
                // Ephemeral chat-only session (incognito)
                const result = await IpcClient.getInstance().createChatOnly();
                chatId = result.chatId;
                console.log(`Created ephemeral chat ${chatId}`);
            }

            // Store input before clearing
            const prompt = inputValue;
            setInputValue('');
            setIsPreviewOpen(false);
            // Don't clear selectedAppId - keep workspace context!

            // Set active chat - this hides templates and shows the chat inline
            setActiveChatId(chatId);

            // Start streaming - response appears in same page
            streamMessage({
                prompt,
                chatId,
                attachments,
            });

            posthog.capture('home:chat-submit', {
                hasWorkspace: !!selectedAppId,
                workspaceId: selectedAppId
            });
            // NO NAVIGATION - same-page chat like ChatGPT
        } catch (error) {
            console.error('Failed to create chat:', error);
            showError('Failed to create chat. ' + (error as any).toString());
        }
    };

    // Handler for continuing chat conversation
    const handleContinueChat = async (prompt: string) => {
        if (!activeChatId || !prompt.trim()) return;
        if (mustSignIn) {
            showError('Please sign in to use chat.');
            return;
        }
        try {
            const chat = await IpcClient.getInstance().getChat(activeChatId);
            if (chat.appId != null) {
                const app = await IpcClient.getInstance().getApp(chat.appId);
                if (app.pathExists === false) {
                    showError('Workspace folder not found. It may have been moved or deleted. Remove it from the list and try again.');
                    return;
                }
            }
            streamMessage({
                prompt,
                chatId: activeChatId,
                attachments: [],
            });
        } catch (e) {
            console.error('Continue chat check failed:', e);
            streamMessage({ prompt, chatId: activeChatId, attachments: [] });
        }
    };

    // Loading state
    if (isLoading) {
        return (
            // Refactor: ThoughtsPanel — Compass animation loading (no logo)
            <AtlarixAnimation size="full" phase="thinking" />
        );
    }

    // Active Chat View - now handled by PersistentChatContainer in layout.tsx
    // Return null so the layout-level chat overlay is visible
    if (activeChatId !== null) {
        return null;
    }

    // Main Home Page
    return (
        <div className="flex-1 flex items-start justify-center overflow-y-auto">
            <ForceCloseDialog
                isOpen={forceCloseDialogOpen}
                onClose={() => setForceCloseDialogOpen(false)}
                performanceData={performanceData}
            />

            <div className="w-full max-w-4xl px-8 pt-12 space-y-8">{/* Content centered within main area */}
                {onboardingStep === 2 && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <span>
                            <strong>Compass</strong> is ready — no API key needed. Start a chat below, then add your own keys in Settings if you want other models.
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                            <Button size="sm" variant="outline" onClick={() => { setOnboardingStep(3); persistOnboardingStep(3); navigate({ to: '/settings' }); }}>
                                Next: Settings
                            </Button>
                        </div>
                    </div>
                )}
                {onboardingStep === 4 && (
                    <div
                        data-onboarding="chat-continuity"
                        className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                    >
                        <span>
                            <strong>No long-lived chat history.</strong> Continuity comes from your Blueprint and project files under{" "}
                            <code className="text-xs bg-muted px-1 rounded">.atlarix</code> (including your plan file).
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    setOnboardingStep(5);
                                    persistOnboardingStep(5);
                                    setSuppressRightAutoOpen(false);
                                    setRightPanelVisible(true);
                                }}
                            >
                                Next: Side panel
                            </Button>
                        </div>
                    </div>
                )}
                {/* Atlarix Header - Enhanced with signature glow effect */}
                <div className="text-center space-y-4">
                    {/* Logo with glow effect - theme-aware */}
                    <div className="flex items-center justify-center gap-4 mb-2">
                        <div className="relative">
                            <div className="absolute inset-0 bg-gradient-to-r from-[#10B981] to-[#059669] blur-xl opacity-30 rounded-full" />
                            <img
                                src={isDarkMode ? '/logo/Atlarix-dark.png' : '/logo/Atlarix-light.png'}
                                alt="Atlarix Logo"
                                className="relative w-16 h-16 object-contain dark:opacity-100 dark:contrast-100 opacity-100 contrast-125"
                                onError={(e) => {
                                    console.error('Failed to load logo:', e.currentTarget.src);
                                    e.currentTarget.style.display = 'none';
                                }}
                            />
                        </div>
                        <h1 className="text-5xl font-bold bg-gradient-to-r from-[#10B981] via-[#059669] to-[#F59E0B] bg-clip-text text-transparent bg-[length:200%_auto] animate-gradient">
                            Atlarix
                        </h1>
                    </div>

                    {/* Tagline */}
                    <p className="text-xl text-muted-foreground">
                        Your AI Development Partner
                    </p>

                    {/* Current Time (for AI context) */}
                    <p className="text-sm text-muted-foreground/60 font-mono">
                        {currentTime}
                    </p>
                </div>

                {/* Setup Banner */}
                <SetupBanner />

                {/* Remind me later: prompt to add API key after skipping in onboarding */}
                {!remindBannerDismissed && typeof window !== 'undefined' && localStorage.getItem('atlarix.onboarding_skipped_ai_setup') && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-foreground flex items-center justify-between gap-4">
                        <span>Add your API key in Settings to start chatting with the AI.</span>
                        <div className="flex items-center gap-2 shrink-0">
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/settings' })}
                                className="text-primary hover:underline font-medium"
                            >
                                Open Settings
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    localStorage.removeItem('atlarix.onboarding_skipped_ai_setup');
                                    setRemindBannerDismissed(true);
                                }}
                                className="text-muted-foreground hover:text-foreground text-xs"
                            >
                                Dismiss
                            </button>
                        </div>
                    </div>
                )}

                {/* Main Input Area - Centered and Focused */}
                <div className="space-y-4 max-w-3xl mx-auto">{/* Added max-w and mx-auto for centering */}

                    {/* Workspace Indicator Badge */}
                    <div className="flex items-center justify-center gap-2">
                        {selectedAppId ? (
                            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20">
                                <span className="text-xs text-primary font-medium">
                                    Chatting in: {selectedWorkspaceInfo?.name || apps.find(a => a.id === selectedAppId)?.name || 'Workspace'}
                                </span>
                                <button
                                    onClick={() => setSelectedAppId(null)}
                                    className="text-primary/60 hover:text-primary text-xs"
                                    title="Switch to incognito mode"
                                >
                                    ✕
                                </button>
                            </div>
                        ) : (
                            <IncognitoIndicator />
                        )}
                    </div>

                    <div data-onboarding="home-chat-input">
                      <HomeChatInput onSubmit={handleSubmit} activeChatId={activeChatId} />
                    </div>

                    {/* Quick Action Templates with Preview Images */}
                    <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap gap-4 justify-center">
                            {templatesLoading ? (
                                <div className="text-sm text-muted-foreground">Loading templates...</div>
                            ) : displayedTemplates.length > 0 ? (
                                displayedTemplates.map((template, index) => (
                                    <button
                                        key={template.id || index}
                                        onClick={() => setInputValue(`@${template.id} `)}
                                        className="flex flex-col items-start gap-2 rounded-xl border border-[#10B981]/20
                                                   bg-card/50 backdrop-blur-sm overflow-hidden
                                                   transition-all duration-200
                                                   hover:bg-card hover:shadow-[0_0_20px_rgba(16,185,129,0.15)] hover:border-[#10B981]/50 hover:scale-[1.02]
                                                   active:scale-[0.98]
                                                   w-[220px]"
                                    >
                                        {/* Preview Image with gradient fallback */}
                                        <div className="w-full h-[140px] bg-gradient-to-br from-[#10B981]/20 via-muted to-[#F59E0B]/20 overflow-hidden">
                                            <img
                                                src={template.imageUrl}
                                                alt={template.title}
                                                className="w-full h-full object-cover"
                                                onError={(e) => {
                                                    // Hide broken image, show gradient background
                                                    e.currentTarget.style.display = 'none';
                                                }}
                                            />
                                        </div>

                                        {/* Content */}
                                        <div className="px-3 pb-3 w-full">
                                            <h3 className="text-sm font-semibold mb-1">
                                                {template.title}
                                            </h3>
                                            <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                                                {template.description || 'No description'}
                                            </p>
                                            {template.techStack && template.techStack.length > 0 && (
                                                <div className="flex flex-wrap gap-1">
                                                    {template.techStack.slice(0, 2).map((tech) => (
                                                        <span
                                                            key={tech}
                                                            className="text-xs px-1.5 py-0.5 rounded bg-[#10B981]/10 text-[#10B981]"
                                                        >
                                                            {tech}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                ))
                            ) : (
                                <div className="text-sm text-muted-foreground">No templates available</div>
                            )}
                        </div>

                        {/* Action Buttons - Atlarix Styled */}
                        <div className="flex gap-3 justify-center flex-wrap">
                            <button
                                onClick={handleMoreIdeas}
                                disabled={templatesLoading || allTemplates.length === 0}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[#10B981]/30 bg-gradient-to-r from-[#10B981]/10 to-[#F59E0B]/10 hover:from-[#10B981]/20 hover:to-[#F59E0B]/20 hover:border-[#10B981]/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-[#10B981]"
                            >
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                    />
                                </svg>
                                <span className="text-sm font-medium">More ideas</span>
                            </button>

                            <button
                                onClick={() => {
                                    setShowSearchDialog(true);
                                    setSearchResults(allTemplates);
                                    setSearchQuery('');
                                }}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[#F59E0B]/30 bg-gradient-to-r from-[#F59E0B]/10 to-[#10B981]/10 hover:from-[#F59E0B]/20 hover:to-[#10B981]/20 hover:border-[#F59E0B]/50 transition-all text-[#F59E0B]"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                                <span className="text-sm font-medium">Search Templates</span>
                            </button>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="text-center space-y-2">{/* Removed banner - provider selection will be in chat */}
                        <p className="text-xs text-muted-foreground">
                            The axis of development.
                        </p>
                        <p className="text-xs text-muted-foreground/60">
                            © 2025-2026 NorahLabs • <a href="https://atlarix.dev" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">atlarix.dev</a>
                        </p>
                    </div>
                </div>

                {/* Global axis line effect (very subtle) */}
                <div className="axis-line fixed left-1/2 top-0 bottom-0 w-px opacity-50" />
            </div>

            {/* Template Search Dialog */}
            {showSearchDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="relative w-full max-w-4xl max-h-[85vh] bg-background rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col m-4">
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                            <div>
                                <h2 className="text-xl font-bold">Search Templates</h2>
                                <p className="text-sm text-muted-foreground">
                                    {searchResults.length} template{searchResults.length !== 1 ? 's' : ''} found
                                    {isSearching && ' (searching live...)'}
                                </p>
                            </div>
                            <button
                                onClick={() => setShowSearchDialog(false)}
                                className="p-2 hover:bg-muted rounded-lg transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        {/* Search Input */}
                        <div className="px-6 py-4 border-b border-border">
                            <div className="relative">
                                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                                <input
                                    type="text"
                                    placeholder="Search templates... (e.g., 'e-commerce', 'dashboard', 'portfolio')"
                                    value={searchQuery}
                                    onChange={(e) => handleTemplateSearch(e.target.value)}
                                    className="w-full pl-10 pr-4 py-3 bg-muted/50 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                                    autoFocus
                                />
                                {isSearching && (
                                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                                    </div>
                                )}
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                                Searches cached templates first, then searches GitHub live if needed
                            </p>
                        </div>

                        {/* Results Grid */}
                        <div className="flex-1 overflow-y-auto p-6">
                            {searchResults.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-48 text-center">
                                    <svg className="w-12 h-12 text-muted-foreground mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    <p className="text-muted-foreground">No templates found. Try a different search term.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {searchResults.map((template) => (
                                        <button
                                            key={template.id}
                                            onClick={() => {
                                                setInputValue(`@${template.id} `);
                                                setShowSearchDialog(false);
                                            }}
                                            className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card/50 overflow-hidden transition-all hover:bg-card hover:shadow-lg hover:border-primary text-left"
                                        >
                                            {/* Preview */}
                                            <div className="w-full h-32 bg-gradient-to-br from-primary/20 via-muted to-accent/20 overflow-hidden relative">
                                                <img
                                                    src={template.imageUrl}
                                                    alt={template.title}
                                                    className="w-full h-full object-cover"
                                                    onError={(e) => {
                                                        // Hide broken image, show gradient
                                                        e.currentTarget.style.display = 'none';
                                                    }}
                                                />
                                            </div>
                                            {/* Content */}
                                            <div className="px-3 pb-3 w-full">
                                                <h3 className="text-sm font-semibold mb-1 line-clamp-1">{template.title}</h3>
                                                <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                                                    {template.description}
                                                </p>
                                                <div className="flex flex-wrap gap-1">
                                                    {template.techStack?.slice(0, 3).map((tech) => (
                                                        <span key={tech} className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                                                            {tech}
                                                        </span>
                                                    ))}
                                                    {template.stars && template.stars > 0 && (
                                                        <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-500">
                                                            ⭐ {template.stars.toLocaleString()}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
