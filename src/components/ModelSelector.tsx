/**
 * Model Selector Component
 * ========================
 * Popup component for selecting AI provider and model
 * Shows paid/free categories for OpenRouter
 */

import { useState, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Zap, Server } from "lucide-react";

interface Model {
    id: string;
    name: string;
    provider: "openrouter" | "ollama" | "lmstudio";
    isPaid?: boolean;
    contextLength?: number;
    pricing?: {
        prompt: string;
        completion: string;
    };
}

interface ModelSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    currentProvider?: string;
    currentModel?: string;
    onSelect: (provider: string, model: Model) => void;
}

export function ModelSelector({
    isOpen,
    onClose,
    currentProvider = "openrouter",
    currentModel,
    onSelect,
}: ModelSelectorProps) {
    const [selectedProvider, setSelectedProvider] = useState(currentProvider);
    const [openRouterModels, setOpenRouterModels] = useState<Model[]>([]);
    const [ollamaModels, setOllamaModels] = useState<Model[]>([]);
    const [lmStudioModels, setLMStudioModels] = useState<Model[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            loadModels(selectedProvider);
        }
    }, [isOpen, selectedProvider]);

    const loadModels = async (provider: string) => {
        setLoading(true);
        try {
            switch (provider) {
                case "openrouter":
                    await fetchOpenRouterModels();
                    break;
                case "ollama":
                    await fetchOllamaModels();
                    break;
                case "lmstudio":
                    await fetchLMStudioModels();
                    break;
            }
        } catch (error) {
            console.error(`Failed to load ${provider} models:`, error);
        } finally {
            setLoading(false);
        }
    };

    const fetchOpenRouterModels = async () => {
        // TODO: Fetch from OpenRouter API
        // For now, placeholder data
        setOpenRouterModels([
            {
                id: "anthropic/claude-3.5-sonnet",
                name: "Claude 3.5 Sonnet",
                provider: "openrouter",
                isPaid: true,
                contextLength: 200000,
                pricing: { prompt: "$3/M", completion: "$15/M" },
            },
            {
                id: "google/gemini-2.0-flash-exp:free",
                name: "Gemini 2.0 Flash",
                provider: "openrouter",
                isPaid: false,
                contextLength: 1000000,
            },
        ]);
    };

    const fetchOllamaModels = async () => {
        // TODO: Call Ollama API to get installed models
        setOllamaModels([
            { id: "llama3.2", name: "Llama 3.2", provider: "ollama" },
        ]);
    };

    const fetchLMStudioModels = async () => {
        // TODO: Call LM Studio API
        setLMStudioModels([
            { id: "local-model", name: "Local Model", provider: "lmstudio" },
        ]);
    };

    const handleModelSelect = (model: Model) => {
        onSelect(selectedProvider, model);
        onClose();
    };

    const freeModels = openRouterModels.filter((m) => !m.isPaid);
    const paidModels = openRouterModels.filter((m) => m.isPaid);

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle>Select AI Provider & Model</DialogTitle>
                </DialogHeader>

                <Tabs
                    value={selectedProvider}
                    onValueChange={setSelectedProvider}
                    className="flex-1 flex flex-col"
                >
                    <TabsList className="grid w-full grid-cols-3">
                        <TabsTrigger value="openrouter">
                            <Sparkles className="w-4 h-4 mr-2" />
                            OpenRouter
                        </TabsTrigger>
                        <TabsTrigger value="ollama">
                            <Zap className="w-4 h-4 mr-2" />
                            Ollama
                        </TabsTrigger>
                        <TabsTrigger value="lmstudio">
                            <Server className="w-4 h-4 mr-2" />
                            LM Studio
                        </TabsTrigger>
                    </TabsList>

                    {/* OpenRouter Models */}
                    <TabsContent value="openrouter" className="flex-1 overflow-y-auto">
                        {loading ? (
                            <div className="text-center py-8 text-muted-foreground">
                                Loading models...
                            </div>
                        ) : (
                            <div className="space-y-6">
                                {/* Free Models */}
                                {freeModels.length > 0 && (
                                    <div>
                                        <h3 className="text-sm font-semibold text-primary mb-3">
                                            Free Models
                                        </h3>
                                        <div className="space-y-2">
                                            {freeModels.map((model) => (
                                                <ModelCard
                                                    key={model.id}
                                                    model={model}
                                                    isSelected={currentModel === model.id}
                                                    onSelect={() => handleModelSelect(model)}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Paid Models */}
                                {paidModels.length > 0 && (
                                    <div>
                                        <h3 className="text-sm font-semibold text-secondary mb-3">
                                            Paid Models
                                        </h3>
                                        <div className="space-y-2">
                                            {paidModels.map((model) => (
                                                <ModelCard
                                                    key={model.id}
                                                    model={model}
                                                    isSelected={currentModel === model.id}
                                                    onSelect={() => handleModelSelect(model)}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </TabsContent>

                    {/* Ollama Models */}
                    <TabsContent value="ollama" className="flex-1 overflow-y-auto">
                        {loading ? (
                            <div className="text-center py-8 text-muted-foreground">
                                Loading models...
                            </div>
                        ) : ollamaModels.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground">
                                No Ollama models installed
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {ollamaModels.map((model) => (
                                    <ModelCard
                                        key={model.id}
                                        model={model}
                                        isSelected={currentModel === model.id}
                                        onSelect={() => handleModelSelect(model)}
                                    />
                                ))}
                            </div>
                        )}
                    </TabsContent>

                    {/* LM Studio Models */}
                    <TabsContent value="lmstudio" className="flex-1 overflow-y-auto">
                        {loading ? (
                            <div className="text-center py-8 text-muted-foreground">
                                Loading models...
                            </div>
                        ) : lmStudioModels.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground">
                                No LM Studio models available
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {lmStudioModels.map((model) => (
                                    <ModelCard
                                        key={model.id}
                                        model={model}
                                        isSelected={currentModel === model.id}
                                        onSelect={() => handleModelSelect(model)}
                                    />
                                ))}
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}

function ModelCard({
    model,
    isSelected,
    onSelect,
}: {
    model: Model;
    isSelected: boolean;
    onSelect: () => void;
}) {
    return (
        <Button
            variant={isSelected ? "default" : "outline"}
            className="w-full justify-start h-auto p-4"
            onClick={onSelect}
        >
            <div className="flex flex-col items-start gap-2 w-full">
                <div className="flex items-center justify-between w-full">
                    <span className="font-medium">{model.name}</span>
                    {model.isPaid !== undefined && (
                        <Badge variant={model.isPaid ? "secondary" : "default"}>
                            {model.isPaid ? "Paid" : "Free"}
                        </Badge>
                    )}
                </div>
                {model.contextLength && (
                    <span className="text-xs text-muted-foreground">
                        {model.contextLength.toLocaleString()} tokens
                    </span>
                )}
                {model.pricing && (
                    <span className="text-xs text-muted-foreground">
                        {model.pricing.prompt} prompt • {model.pricing.completion}{" "}
                        completion
                    </span>
                )}
            </div>
        </Button>
    );
}
