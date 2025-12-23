/**
 * Atlarix Provider Selector
 * =========================
 * UI for selecting and switching between AI providers (BYOK)
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Circle, CheckCircle2, XCircle, Key } from "lucide-react";
import { ProviderManager } from "@/lib/providers";
import type { ProviderType } from "@/lib/providers";

interface ProviderStatus {
    type: ProviderType;
    name: string;
    available: boolean;
    models: string[];
    requiresApiKey: boolean;
}

interface ProviderSelectorProps {
    onProviderChange: (provider: ProviderType, model: string) => void;
    currentProvider?: ProviderType;
    currentModel?: string;
}

export function ProviderSelector({
    onProviderChange,
    currentProvider,
    currentModel,
}: ProviderSelectorProps) {
    const [providers, setProviders] = useState<ProviderStatus[]>([
        { type: "ollama", name: "Ollama", available: false, models: [], requiresApiKey: false },
        { type: "lmstudio", name: "LMStudio", available: false, models: [], requiresApiKey: false },
        { type: "openrouter", name: "OpenRouter", available: false, models: [], requiresApiKey: true },
    ]);

    const [selectedProvider, setSelectedProvider] = useState<ProviderType>(
        currentProvider || "ollama"
    );
    const [selectedModel, setSelectedModel] = useState<string>(
        currentModel || ""
    );
    const [openRouterApiKey, setOpenRouterApiKey] = useState<string>("");
    const [isCheckingProviders, setIsCheckingProviders] = useState(false);

    useEffect(() => {
        // Load saved OpenRouter API key
        const savedKey = localStorage.getItem("openrouter_api_key");
        if (savedKey) {
            setOpenRouterApiKey(savedKey);
        }

        checkProviderAvailability();
    }, []);

    const checkProviderAvailability = async () => {
        setIsCheckingProviders(true);

        const updated = await Promise.all(
            providers.map(async (p) => {
                try {
                    // For OpenRouter, check if API key is set
                    if (p.type === "openrouter") {
                        const apiKey = localStorage.getItem("openrouter_api_key");
                        if (!apiKey) {
                            return { ...p, available: false, models: [] };
                        }
                    }

                    // Check if provider is available
                    const available = await ProviderManager.checkProviderAvailability(p.type);

                    // Get models if available
                    const models = available
                        ? await ProviderManager.listProviderModels(p.type)
                        : [];

                    return { ...p, available, models };
                } catch (error) {
                    console.error(`Failed to check ${p.type}:`, error);
                    return { ...p, available: false, models: [] };
                }
            })
        );

        setProviders(updated);
        setIsCheckingProviders(false);

        // Auto-select first available provider
        const firstAvailable = updated.find((p) => p.available);
        if (firstAvailable && !currentProvider) {
            setSelectedProvider(firstAvailable.type);
            if (firstAvailable.models[0]) {
                setSelectedModel(firstAvailable.models[0]);
                onProviderChange(firstAvailable.type, firstAvailable.models[0]);
            }
        }
    };

    const handleProviderChange = (providerType: ProviderType) => {
        setSelectedProvider(providerType);
        const provider = providers.find((p) => p.type === providerType);

        if (provider && provider.models[0]) {
            setSelectedModel(provider.models[0]);
            onProviderChange(providerType, provider.models[0]);
        }
    };

    const handleModelChange = (model: string) => {
        setSelectedModel(model);
        onProviderChange(selectedProvider, model);
    };

    const handleSaveOpenRouterKey = () => {
        localStorage.setItem("openrouter_api_key", openRouterApiKey);
        checkProviderAvailability(); // Recheck after saving key
    };

    const getStatusIcon = (available: boolean) => {
        if (available) {
            return <CheckCircle2 className="h-3 w-3 text-emerald-signal" />;
        }
        return <XCircle className="h-3 w-3 text-muted-foreground" />;
    };

    const currentProviderData = providers.find((p) => p.type === selectedProvider);

    return (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
            {/* Provider Selection */}
            <div className="space-y-2">
                <label className="text-sm font-medium">AI Provider</label>

                <div className="grid grid-cols-3 gap-2">
                    {providers.map((provider) => (
                        <Button
                            key={provider.type}
                            variant={selectedProvider === provider.type ? "default" : "outline"}
                            className={`gap-2 ${selectedProvider === provider.type ? "atlarix-glow" : ""}`}
                            onClick={() => handleProviderChange(provider.type)}
                            disabled={!provider.available || isCheckingProviders}
                        >
                            {getStatusIcon(provider.available)}
                            {provider.name}
                        </Button>
                    ))}
                </div>

                <Button
                    onClick={checkProviderAvailability}
                    variant="ghost"
                    size="sm"
                    disabled={isCheckingProviders}
                    className="w-full text-xs"
                >
                    {isCheckingProviders ? "Checking..." : "🔄 Refresh Providers"}
                </Button>
            </div>

            {/* OpenRouter API Key Input */}
            {selectedProvider === "openrouter" && (
                <div className="space-y-2">
                    <Label htmlFor="openrouter-key" className="text-sm flex items-center gap-2">
                        <Key className="h-3 w-3" />
                        OpenRouter API Key
                    </Label>
                    <div className="flex gap-2">
                        <Input
                            id="openrouter-key"
                            type="password"
                            placeholder="sk-or-..."
                            value={openRouterApiKey}
                            onChange={(e) => setOpenRouterApiKey(e.target.value)}
                            className="flex-1"
                        />
                        <Button onClick={handleSaveOpenRouterKey} size="sm">
                            Save
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Get your API key from{" "}
                        <a
                            href="https://openrouter.ai/keys"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                        >
                            openrouter.ai/keys
                        </a>
                    </p>
                </div>
            )}

            {/* Model Selection */}
            {currentProviderData && currentProviderData.available && (
                <div className="space-y-2">
                    <label className="text-sm font-medium">Model</label>

                    <Select value={selectedModel} onValueChange={handleModelChange}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select a model" />
                        </SelectTrigger>
                        <SelectContent>
                            {currentProviderData.models.map((model) => (
                                <SelectItem key={model} value={model}>
                                    {model}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Circle className="h-2 w-2 fill-emerald-signal text-emerald-signal" />
                        Connected - {currentProviderData.models.length} model(s) available
                    </div>
                </div>
            )}

            {/* No Provider Available Warning */}
            {!providers.some((p) => p.available) && !isCheckingProviders && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                    <p className="text-sm text-destructive font-medium">⚠️ No providers available</p>
                    <p className="text-xs text-muted-foreground mt-1">
                        • Start Ollama: <code className="text-xs">ollama serve</code>
                        <br />
                        • Start LMStudio and enable local server
                        <br />
                        • Or add OpenRouter API key above
                    </p>
                </div>
            )}
        </div>
    );
}
