/**
 * Atlarix Upgrade Prompt (Free Tier Soft Lock)
 * =============================================
 * Shown when user hits 5 prompt limit
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Clock, Zap, Check } from "lucide-react";

interface UpgradePromptProps {
    isOpen: boolean;
    onClose: () => void;
    promptsRemaining: number;
    resetTime: Date;
}

export function UpgradePrompt({
    isOpen,
    onClose,
    promptsRemaining,
    resetTime,
}: UpgradePromptProps) {
    const [timeUntilReset, setTimeUntilReset] = useState("");

    useEffect(() => {
        const updateTimer = () => {
            const now = new Date();
            const diff = resetTime.getTime() - now.getTime();

            if (diff <= 0) {
                setTimeUntilReset("Resetting now...");
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

    const handleUpgrade = (plan: "monthly" | "annual") => {
        // TODO: Open checkout page with pre-filled email
        const checkoutUrl = `https://atlarix.com/pricing?plan=${plan}`;
        window.electron?.shell.openExternal(checkoutUrl);
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <div className="flex items-center justify-center mb-4">
                        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                            <Zap className="h-8 w-8 text-primary" />
                        </div>
                    </div>

                    <DialogTitle className="text-center text-2xl">
                        Daily Limit Reached
                    </DialogTitle>
                    <DialogDescription className="text-center text-base">
                        You've used all <span className="font-semibold text-foreground">5 free prompts</span> for today.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6">
                    {/* Reset Timer */}
                    <div className="flex items-center justify-center gap-2 p-4 bg-muted rounded-lg">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">
                            Prompts reset in <span className="font-semibold text-foreground">{timeUntilReset}</span>
                        </span>
                    </div>

                    {/* Pricing Options */}
                    <div className="space-y-3">
                        {/* Monthly */}
                        <div className="border border-primary/20 rounded-lg p-4 hover:border-primary transition-colors">
                            <div className="flex items-center justify-between mb-3">
                                <div>
                                    <h4 className="font-semibold text-lg">Monthly Pro</h4>
                                    <p className="text-sm text-muted-foreground">Best for flexibility</p>
                                </div>
                                <div className="text-right">
                                    <div className="text-2xl font-bold text-primary">$19</div>
                                    <div className="text-xs text-muted-foreground">per month</div>
                                </div>
                            </div>

                            <ul className="space-y-2 mb-4">
                                <li className="flex items-center gap-2 text-sm">
                                    <Check className="h-4 w-4 text-primary" />
                                    Unlimited prompts
                                </li>
                                <li className="flex items-center gap-2 text-sm">
                                    <Check className="h-4 w-4 text-primary" />
                                    Unlimited projects
                                </li>
                                <li className="flex items-center gap-2 text-sm">
                                    <Check className="h-4 w-4 text-primary" />
                                    All future versions
                                </li>
                            </ul>

                            <Button
                                onClick={() => handleUpgrade("monthly")}
                                className="w-full atlarix-glow"
                            >
                                Upgrade to Monthly
                            </Button>
                        </div>

                        {/* Annual */}
                        <div className="border border-primary rounded-lg p-4 bg-primary/5">
                            <div className="flex items-center justify-between mb-3">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h4 className="font-semibold text-lg">Annual Pro</h4>
                                        <span className="text-xs bg-emerald-signal text-white px-2 py-0.5 rounded-full">
                                            Save $49
                                        </span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">Best value</p>
                                </div>
                                <div className="text-right">
                                    <div className="text-2xl font-bold text-primary">$179</div>
                                    <div className="text-xs text-muted-foreground">per year</div>
                                </div>
                            </div>

                            <ul className="space-y-2 mb-4">
                                <li className="flex items-center gap-2 text-sm">
                                    <Check className="h-4 w-4 text-primary" />
                                    Everything in Monthly
                                </li>
                                <li className="flex items-center gap-2 text-sm">
                                    <Check className="h-4 w-4 text-primary" />
                                    2 months free
                                </li>
                                <li className="flex items-center gap-2 text-sm">
                                    <Check className="h-4 w-4 text-primary" />
                                    Locked-in price
                                </li>
                            </ul>

                            <Button
                                onClick={() => handleUpgrade("annual")}
                                className="w-full bg-primary hover:bg-primary/90"
                            >
                                Upgrade to Annual
                            </Button>
                        </div>
                    </div>

                    {/* Continue on Free */}
                    <Button onClick={onClose} variant="ghost" className="w-full">
                        I'll wait for free prompts to reset
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
