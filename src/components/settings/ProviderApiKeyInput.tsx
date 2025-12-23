import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, ExternalLink } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { toast } from "sonner";

interface ProviderApiKeyInputProps {
    providerId: string;
    providerName: string;
    providerWebsiteUrl?: string;
}

export function ProviderApiKeyInput({
    providerId,
    providerName,
    providerWebsiteUrl,
}: ProviderApiKeyInputProps) {
    const [apiKey, setApiKey] = useState<string>("");
    const [showKey, setShowKey] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // Load existing API key on mount
    useEffect(() => {
        const loadKey = async () => {
            try {
                const key = await IpcClient.getInstance().getProviderApiKey(providerId);
                if (key) {
                    setApiKey(key);
                }
            } catch (error) {
                console.error("Error loading API key:", error);
            } finally {
                setIsLoading(false);
            }
        };
        loadKey();
    }, [providerId]);

    // Save API key
    const handleSaveKey = async () => {
        const trimmedKey = apiKey.trim();
        if (!trimmedKey) {
            toast.error("API key cannot be empty");
            return;
        }

        setIsSaving(true);
        try {
            await IpcClient.getInstance().setProviderApiKey(providerId, trimmedKey);
            toast.success("API key saved! Please refresh the page to load models.");
        } catch (error) {
            console.error("Error saving API key:", error);
            toast.error("Failed to save API key");
        } finally {
            setIsSaving(false);
        }
    };

    // Delete API key
    const handleDeleteKey = async () => {
        setIsSaving(true);
        try {
            await IpcClient.getInstance().deleteProviderApiKey(providerId);
            setApiKey("");
            toast.success("API key deleted");
        } catch (error) {
            console.error("Error deleting API key:", error);
            toast.error("Failed to delete API key");
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) {
        return <div className="text-sm text-muted-foreground">Loading...</div>;
    }

    return (
        <div className="space-y-4 p-6 bg-muted/30 rounded-lg border">
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <Label htmlFor="api-key">API Key</Label>
                    {providerWebsiteUrl && (
                        <a
                            href={providerWebsiteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                        >
                            Get API Key
                            <ExternalLink className="h-3 w-3" />
                        </a>
                    )}
                </div>

                <div className="flex gap-2">
                    <div className="relative flex-1">
                        <Input
                            id="api-key"
                            type={showKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder={`Enter your ${providerName} API key...`}
                            className="pr-10"
                        />
                        <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={() => setShowKey(!showKey)}
                            className="absolute right-0 top-0 h-full px-3"
                        >
                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                    </div>
                </div>

                <p className="text-xs text-muted-foreground">
                    Your API key is stored locally and never sent to our servers.
                </p>
            </div>

            <div className="flex gap-2">
                <Button
                    onClick={handleSaveKey}
                    disabled={isSaving || !apiKey.trim()}
                >
                    {isSaving ? "Saving..." : "Save API Key"}
                </Button>

                {apiKey && (
                    <Button
                        variant="destructive"
                        onClick={handleDeleteKey}
                        disabled={isSaving}
                    >
                        Delete Key
                    </Button>
                )}
            </div>
        </div>
    );
}
