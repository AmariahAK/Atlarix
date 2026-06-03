/**
 * SearxNG Auto-Setup Component
 * =============================
 * One-click setup UI for SearxNG via Docker
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
    Loader2,
    CheckCircle,
    XCircle,
    AlertCircle,
    Download,
    Play,
    Square,
    RefreshCw,
    ExternalLink,
} from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";

interface DockerStatus {
    installed: boolean;
    running: boolean;
    error?: string;
}

interface ContainerStatus {
    running: boolean;
    containerId?: string;
}

interface SetupResult {
    success: boolean;
    message: string;
    url?: string;
}

export function SearxngSetup() {
    const [dockerStatus, setDockerStatus] = useState<DockerStatus | null>(null);
    const [containerStatus, setContainerStatus] = useState<ContainerStatus>({ running: false });
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [isChecking, setIsChecking] = useState<boolean>(true);
    const [message, setMessage] = useState<string>("");
    const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

    useEffect(() => {
        checkStatus();
    }, []);

    async function checkStatus() {
        setIsChecking(true);
        try {
            const docker = await window.electron?.ipcRenderer.invoke("searxng:check-docker") as DockerStatus;
            setDockerStatus(docker);

            if (docker.running) {
                const container = await window.electron?.ipcRenderer.invoke("searxng:check-status") as ContainerStatus;
                setContainerStatus(container);

                // If running, update in-memory config for search tools
                if (container.running) {
                    try {
                        await IpcClient.getInstance().syncSearxngConfig({
                            url: "http://127.0.0.1:8080",
                            enabled: true,
                        });
                    } catch {
                        // DB might not have table yet, but in-memory config will work
                        console.log("[SearxngSetup] Config sync skipped (migration pending)");
                    }
                }
            }
        } catch (error) {
            console.error("[SearxngSetup] Status check error:", error);
        } finally {
            setIsChecking(false);
        }
    }

    async function handleSetup() {
        setIsLoading(true);
        setMessage("Setting up SearxNG...");
        setMessageType("info");

        try {
            const result = await window.electron?.ipcRenderer.invoke("searxng:setup") as SetupResult;

            if (result.success) {
                setMessageType("success");
                setMessage(result.message);
                setContainerStatus({ running: true });

                // Try to save URL to settings (may fail if migration pending)
                if (result.url) {
                    try {
                        await IpcClient.getInstance().syncSearxngConfig({
                            url: result.url,
                            enabled: true,
                        });
                    } catch {
                        console.log("[SearxngSetup] Config sync skipped");
                    }
                }
            } else {
                setMessageType("error");
                setMessage(result.message);
            }
        } catch (error: any) {
            setMessageType("error");
            setMessage(`Setup failed: ${error.message}`);
        } finally {
            setIsLoading(false);
        }
    }

    async function handleStop() {
        setIsLoading(true);
        setMessage("Stopping SearxNG...");
        setMessageType("info");

        try {
            const result = await window.electron?.ipcRenderer.invoke("searxng:stop") as SetupResult;
            if (result.success) {
                setMessageType("success");
                setMessage("SearxNG stopped");
                setContainerStatus({ running: false });

                // Try to disable in settings (may fail if migration pending)
                try {
                    await IpcClient.getInstance().syncSearxngConfig({
                        url: null,
                        enabled: false,
                    });
                } catch {
                    console.log("[SearxngSetup] Config sync skipped");
                }
            } else {
                setMessageType("error");
                setMessage(result.message);
            }
        } catch (error: any) {
            setMessageType("error");
            setMessage(`Failed to stop: ${error.message}`);
        } finally {
            setIsLoading(false);
        }
    }

    // Loading state
    if (isChecking) {
        return (
            <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Checking Docker status...</span>
                </div>
            </div>
        );
    }

    // Docker not installed
    if (!dockerStatus?.installed) {
        return (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 space-y-3">
                        <div>
                            <h3 className="font-semibold text-amber-600 dark:text-amber-400">Docker Required</h3>
                            <p className="text-sm text-muted-foreground mt-1">
                                SearxNG requires Docker Desktop to run. Install it to enable unlimited,
                                high-quality web search.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.open("https://docker.com", "_blank")}
                            className="gap-2"
                        >
                            <Download className="h-3 w-3" />
                            Download Docker Desktop
                            <ExternalLink className="h-3 w-3" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={checkStatus}
                            className="ml-2"
                        >
                            <RefreshCw className="h-3 w-3 mr-1" />
                            Check Again
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    // Docker installed but not running
    if (!dockerStatus?.running) {
        return (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 space-y-3">
                        <div>
                            <h3 className="font-semibold text-amber-600 dark:text-amber-400">Start Docker Desktop</h3>
                            <p className="text-sm text-muted-foreground mt-1">
                                Docker is installed but not running. Please start Docker Desktop to enable SearxNG.
                            </p>
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={checkStatus}
                        >
                            <RefreshCw className="h-3 w-3 mr-1" />
                            Check Again
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    // Docker running - show setup/status
    return (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
            <div className="flex items-start justify-between">
                <div>
                    <h3 className="font-semibold">Auto-Setup (Docker)</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        One-click SearxNG setup - no configuration needed
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {containerStatus.running ? (
                        <>
                            <CheckCircle className="h-4 w-4 text-emerald-500" />
                            <span className="text-xs font-medium text-emerald-600">Running</span>
                        </>
                    ) : (
                        <>
                            <XCircle className="h-4 w-4 text-slate-400" />
                            <span className="text-xs font-medium text-muted-foreground">Stopped</span>
                        </>
                    )}
                </div>
            </div>

            {/* Status message */}
            {message && (
                <div
                    className={`flex items-start gap-2 p-3 rounded-md text-xs ${messageType === "success"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : messageType === "error"
                            ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                            : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        }`}
                >
                    {messageType === "success" && <CheckCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />}
                    {messageType === "error" && <XCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />}
                    {messageType === "info" && <Loader2 className="h-3 w-3 mt-0.5 animate-spin flex-shrink-0" />}
                    <span>{message}</span>
                </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
                {!containerStatus.running ? (
                    <Button
                        onClick={handleSetup}
                        disabled={isLoading}
                        size="sm"
                        className="bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700"
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                Setting up...
                            </>
                        ) : (
                            <>
                                <Play className="h-3 w-3 mr-2" />
                                Start SearxNG
                            </>
                        )}
                    </Button>
                ) : (
                    <Button
                        onClick={handleStop}
                        disabled={isLoading}
                        variant="outline"
                        size="sm"
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                Stopping...
                            </>
                        ) : (
                            <>
                                <Square className="h-3 w-3 mr-2" />
                                Stop SearxNG
                            </>
                        )}
                    </Button>
                )}

                <Button
                    variant="ghost"
                    size="sm"
                    onClick={checkStatus}
                    disabled={isLoading}
                >
                    <RefreshCw className="h-3 w-3" />
                </Button>
            </div>

            {/* Running info */}
            {containerStatus.running && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Running at</span>
                    <code className="px-1.5 py-0.5 bg-muted rounded text-[10px]">
                        http://127.0.0.1:8080
                    </code>
                </div>
            )}
        </div>
    );
}
