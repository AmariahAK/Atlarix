/**
 * IterationProgressBar - Gaming-style progress bar for agentic loop
 * 
 * Hybrid UX:
 * - Progress bar at top of ChatPanel (slim, non-intrusive)
 * - Continue prompt as center modal (impossible to miss)
 * 
 * Uses theme colors from globals.css:
 * - Primary (Emerald) for healthy progress
 * - Accent (Amber) for warning zone
 * - Destructive (Red) for danger zone
 */

import { useEffect, useState, useCallback } from 'react';
import { Zap, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface IterationProgress {
    chatId: number;
    iteration: number;
    maxIterations: number;
    totalToolsExecuted: number;
}

interface IterationWarning {
    chatId: number;
    iteration: number;
    maxIterations: number;
    totalToolsExecuted: number;
    estimatedTokens: number;
    message: string;
}

interface Props {
    chatId: number;
}

// Access the electron IPC
const electron = (window as any).electron;

export function IterationProgressBar({ chatId }: Props) {
    const [progress, setProgress] = useState<IterationProgress | null>(null);
    const [showContinueModal, setShowContinueModal] = useState(false);
    const [warningData, setWarningData] = useState<IterationWarning | null>(null);

    useEffect(() => {
        if (!electron?.ipcRenderer) return;

        const unsubProgress = electron.ipcRenderer.on(
            'chat:iteration:progress',
            (data: unknown) => {
                const payload = data as IterationProgress;
                // Accept progress from ANY chat - the backend knows which is active
                // This fixes ephemeral chats where frontend doesn't have the chatId
                setProgress(payload);
            }
        );

        const unsubWarning = electron.ipcRenderer.on(
            'chat:iteration:warning',
            (data: unknown) => {
                const payload = data as IterationWarning;
                if (payload.chatId === chatId) {
                    setWarningData(payload);
                    setShowContinueModal(true);
                }
            }
        );

        const unsubLimitReached = electron.ipcRenderer.on(
            'chat:iteration:limit-reached',
            (data: unknown) => {
                const payload = data as { chatId: number };
                if (payload.chatId === chatId) {
                    setProgress(null);
                }
            }
        );

        const unsubTimeout = electron.ipcRenderer.on(
            'chat:iteration:timeout',
            (data: unknown) => {
                const payload = data as { chatId: number };
                if (payload.chatId === chatId) {
                    setProgress(null);
                }
            }
        );

        return () => {
            unsubProgress?.();
            unsubWarning?.();
            unsubLimitReached?.();
            unsubTimeout?.();
        };
    }, [chatId]);

    // Reset on chatId change
    useEffect(() => {
        return () => {
            setProgress(null);
            setShowContinueModal(false);
        };
    }, [chatId]);

    // Modal action handlers
    const handleContinue = useCallback(() => {
        setShowContinueModal(false);
        if (progress) {
            setProgress({ ...progress, maxIterations: progress.maxIterations + 10 });
        }
    }, [progress]);

    const handlePause = useCallback(() => {
        // Pause keeps progress visible but closes modal
        setShowContinueModal(false);
    }, []);

    const handleStop = useCallback(() => {
        setShowContinueModal(false);
        setProgress(null);
    }, []);

    if (!progress) return null;

    const unboundedProgress = progress.maxIterations <= 0;
    const percentage = unboundedProgress
      ? 0
      : Math.min(100, (progress.iteration / progress.maxIterations) * 100);
    const isWarningZone = !unboundedProgress && percentage > 75;
    const isDangerZone = !unboundedProgress && percentage > 90;

    return (
        <>
            {/* ═══════════════════════════════════════════════════════════
          PROGRESS BAR - Top of ChatPanel
          Uses theme colors: primary (emerald), accent (amber), destructive
          ═══════════════════════════════════════════════════════════ */}
            <div className="w-full bg-card border-b border-border">
                <div className="px-4 py-2">
                    <div className="flex items-center gap-3">
                        {/* Icon - uses theme colors */}
                        <div className="flex-shrink-0">
                            {isDangerZone ? (
                                <AlertTriangle className="w-4 h-4 text-destructive animate-pulse" />
                            ) : (
                                <Zap className={cn(
                                    "w-4 h-4",
                                    isWarningZone ? "text-accent" : "text-primary"
                                )} />
                            )}
                        </div>

                        {/* Progress bar */}
                        <div className="flex-1">
                            <div className="relative h-3 bg-muted rounded-full overflow-hidden">
                                {/* Grid pattern overlay */}
                                <div
                                    className="absolute inset-0 opacity-10"
                                    style={{
                                        backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 10px, currentColor 10px, currentColor 11px)',
                                    }}
                                />

                                {/* Actual bar - theme colors */}
                                <div
                                    className={cn(
                                        "h-full transition-all duration-300 ease-out relative overflow-hidden",
                                        isDangerZone ? "bg-destructive"
                                            : isWarningZone ? "bg-accent"
                                                : "bg-primary"
                                    )}
                                    style={{ width: `${percentage}%` }}
                                >
                                    {/* Shine animation */}
                                    <div
                                        className="absolute inset-0 animate-pulse"
                                        style={{
                                            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
                                        }}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Iteration count */}
                        <div className="flex-shrink-0 text-xs font-mono">
                            <span className={cn(
                                unboundedProgress ? "text-primary"
                                    : isDangerZone ? "text-destructive"
                                    : isWarningZone ? "text-accent"
                                        : "text-primary"
                            )}>
                                {progress.iteration}
                            </span>
                            {!unboundedProgress ? (
                              <span className="text-muted-foreground">/{progress.maxIterations}</span>
                            ) : (
                              <span className="text-muted-foreground"> rounds</span>
                            )}
                        </div>
                    </div>

                    {/* Tool counter */}
                    <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
                        <span>{progress.totalToolsExecuted} tools executed</span>
                        {!unboundedProgress && isWarningZone && !showContinueModal && (
                            <span className="text-accent animate-pulse">
                                Approaching limit...
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════
          CONTINUE MODAL - Center of screen, unmissable
          ═══════════════════════════════════════════════════════════ */}
            {showContinueModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-card border-2 border-accent/30 rounded-lg shadow-2xl p-6 max-w-md mx-4 animate-in zoom-in-95 duration-200">
                        {/* Header */}
                        <div className="flex items-start gap-3 mb-4">
                            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
                                <AlertTriangle className="w-5 h-5 text-accent" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-foreground mb-1">
                                    Task Running Long
                                </h3>
                                <p className="text-sm text-muted-foreground">
                                    Completed <strong className="text-foreground">{progress?.iteration}</strong> iterations
                                    and executed <strong className="text-foreground">{progress?.totalToolsExecuted}</strong> tools.
                                </p>
                                <p className="text-sm text-muted-foreground mt-2">
                                    Continue for 10 more iterations?
                                </p>
                            </div>
                        </div>

                        {/* Main actions */}
                        <div className="flex gap-3">
                            <button
                                onClick={handleContinue}
                                className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md font-medium transition-colors"
                            >
                                Continue (+10)
                            </button>
                            <button
                                onClick={handlePause}
                                className="flex-1 px-4 py-2.5 bg-muted hover:bg-muted/80 text-foreground rounded-md font-medium transition-colors"
                            >
                                Pause
                            </button>
                        </div>

                        {/* Stop option */}
                        <button
                            onClick={handleStop}
                            className="w-full mt-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                        >
                            Stop Task
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}

export default IterationProgressBar;
