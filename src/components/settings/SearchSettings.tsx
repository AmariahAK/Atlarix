/**
 * Search Settings Component
 * =========================
 * UI for configuring SearxNG search settings
 * Similar to OpenRouter API key pattern
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    CheckCircle2,
    XCircle,
    Search,
    Settings2,
    ExternalLink
} from "lucide-react";
import {
    getSearxngURL,
    setSearxngURL,
    isSearxngEnabled,
    setSearxngEnabled
} from "@/lib/search";
import { IpcClient } from "@/ipc/ipc_client";

export function SearchSettings() {
    const [searxngUrl, setSearxngUrlState] = useState<string>("");
    const [isEnabled, setIsEnabled] = useState<boolean>(false);
    const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
    const [isChecking, setIsChecking] = useState<boolean>(false);

    useEffect(() => {
        // Load saved settings
        const url = getSearxngURL();
        if (url) {
            setSearxngUrlState(url);
        }
        setIsEnabled(isSearxngEnabled());
    }, []);

    const handleSave = async () => {
        // Save URL and enabled state to localStorage
        if (searxngUrl.trim()) {
            setSearxngURL(searxngUrl.trim());
        }
        setSearxngEnabled(isEnabled);

        // Sync config to main process (for tools that run in main)
        await IpcClient.getInstance().syncSearxngConfig({
            url: searxngUrl.trim() || null,
            enabled: isEnabled
        });
        console.log('[SearchSettings] Config synced to main process');

        // Check health if enabled
        if (isEnabled && searxngUrl.trim()) {
            await checkHealth();
        }
    };

    const checkHealth = async () => {
        if (!searxngUrl.trim()) return;

        setIsChecking(true);
        try {
            // Use IPC client to make request from main process (bypasses CORS)
            const result = await IpcClient.getInstance().checkSearxngHealth(searxngUrl.trim());
            setIsHealthy(result.success);
            if (!result.success) {
                console.log('[SearchSettings] Health check failed:', result.error);
            }
        } catch (e) {
            console.error('[SearchSettings] Health check error:', e);
            setIsHealthy(false);
        }
        setIsChecking(false);
    };

    const handleToggle = (enabled: boolean) => {
        setIsEnabled(enabled);
        setSearxngEnabled(enabled);
    };

    return (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Search className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">Power Search (SearxNG)</span>
                </div>
                <Switch
                    checked={isEnabled}
                    onCheckedChange={handleToggle}
                />
            </div>

            {isEnabled && (
                <div className="space-y-3 pt-2">
                    <div className="space-y-2">
                        <Label htmlFor="searxng-url" className="text-sm flex items-center gap-2">
                            <Settings2 className="h-3 w-3" />
                            SearxNG Instance URL
                        </Label>
                        <div className="flex gap-2">
                            <Input
                                id="searxng-url"
                                type="url"
                                placeholder="http://127.0.0.1:8080"
                                value={searxngUrl}
                                onChange={(e) => setSearxngUrlState(e.target.value)}
                                className="flex-1"
                            />
                            <Button onClick={handleSave} size="sm" disabled={isChecking}>
                                {isChecking ? "..." : "Save"}
                            </Button>
                        </div>
                    </div>

                    {/* Status indicator */}
                    {isHealthy !== null && (
                        <div className="flex items-center gap-2 text-xs">
                            {isHealthy ? (
                                <>
                                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                                    <span className="text-emerald-600">Connected - Unlimited searches available</span>
                                </>
                            ) : (
                                <>
                                    <XCircle className="h-3 w-3 text-destructive" />
                                    <span className="text-destructive">Cannot connect - check URL and ensure SearxNG is running</span>
                                </>
                            )}
                        </div>
                    )}

                    {/* Quick setup guide */}
                    <div className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-2">
                        <p className="font-medium">Quick Setup (requires Docker):</p>
                        <code className="block bg-background px-2 py-1 rounded text-[10px]">
                            docker run -d -p 8080:8080 --name atlarix-searxng searxng/searxng
                        </code>
                        <a
                            href="https://docs.searxng.org/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                            <ExternalLink className="h-3 w-3" />
                            SearxNG Documentation
                        </a>
                    </div>

                    <p className="text-xs text-muted-foreground">
                        SearxNG aggregates Google, Bing, StackOverflow, Reddit, GitHub, and 70+ other search engines.
                    </p>
                </div>
            )}

            {!isEnabled && (
                <p className="text-xs text-muted-foreground">
                    Using DuckDuckGo (default). Enable for unlimited, high-quality results.
                </p>
            )}
        </div>
    );
}
