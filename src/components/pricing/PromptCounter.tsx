/**
 * Atlarix Prompt Counter Component
 * =================================
 * Shows remaining free prompts with countdown timer
 */

import { useState, useEffect } from "react";
import { Progress } from "@/components/ui/progress";
import { Clock, Zap } from "lucide-react";

interface PromptCounterProps {
    promptsRemaining: number;
    totalPrompts: number;
    resetTime: Date;
    onUpgradeClick: () => void;
}

export function PromptCounter({
    promptsRemaining,
    totalPrompts,
    resetTime,
    onUpgradeClick,
}: PromptCounterProps) {
    const [timeUntilReset, setTimeUntilReset] = useState("");

    useEffect(() => {
        const updateTimer = () => {
            const now = new Date();
            const diff = resetTime.getTime() - now.getTime();

            if (diff <= 0) {
                setTimeUntilReset("Resetting...");
                return;
            }

            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

            setTimeUntilReset(`${hours}h ${minutes}m`);
        };

        updateTimer();
        const interval = setInterval(updateTimer, 60000); // Update every minute

        return () => clearInterval(interval);
    }, [resetTime]);

    const percentage = (promptsRemaining / totalPrompts) * 100;
    const isLow = promptsRemaining <= 1;

    return (
        <div className="rounded-lg border border-border bg-card p-3 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Zap className={`h-4 w-4 ${isLow ? "text-destructive" : "text-primary"}`} />
                    <span className="text-sm font-medium">
                        {promptsRemaining}/{totalPrompts} Free Prompts
                    </span>
                </div>
                {isLow && (
                    <button
                        onClick={onUpgradeClick}
                        className="text-xs text-primary hover:underline font-medium"
                    >
                        Upgrade
                    </button>
                )}
            </div>

            {/* Progress Bar */}
            <Progress
                value={percentage}
                className={`h-2 ${isLow ? "[&>div]:bg-destructive" : "[&>div]:bg-primary"}`}
            />

            {/* Reset Timer */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Resets in {timeUntilReset}</span>
            </div>

            {/* Warning Message */}
            {isLow && (
                <div className="text-xs text-destructive font-medium">
                    ⚠️ Low on prompts! Upgrade for unlimited.
                </div>
            )}
        </div>
    );
}
