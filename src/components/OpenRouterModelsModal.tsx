import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import type { LanguageModel } from "@/ipc/ipc_types";
import { PriceBadge } from "@/components/PriceBadge";
import { cn } from "@/lib/utils";

interface OpenRouterModelsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectModel: (apiName: string) => void;
    models: LanguageModel[];
    currentModelName?: string;
}

const MODELS_PER_PAGE = 20;

export function OpenRouterModelsModal({
    isOpen,
    onClose,
    onSelectModel,
    models,
    currentModelName,
}: OpenRouterModelsModalProps) {
    const [searchQuery, setSearchQuery] = useState("");
    const [freeModelsPage, setFreeModelsPage] = useState(1);
    const [paidModelsPage, setPaidModelsPage] = useState(1);

    // Split and filter models
    const { freeModels, paidModels } = useMemo(() => {
        // Filter by search query
        const filtered = models.filter((m) =>
            m.displayName.toLowerCase().includes(searchQuery.toLowerCase())
        );

        // Split into free and paid
        const free = filtered.filter((m) => (m.dollarSigns || 0) === 0);
        const paid = filtered.filter((m) => (m.dollarSigns || 0) > 0);

        return { freeModels: free, paidModels: paid };
    }, [models, searchQuery]);

    // Paginated results
    const freePageModels = freeModels.slice(
        (freeModelsPage - 1) * MODELS_PER_PAGE,
        freeModelsPage * MODELS_PER_PAGE
    );

    const paidPageModels = paidModels.slice(
        (paidModelsPage - 1) * MODELS_PER_PAGE,
        paidModelsPage * MODELS_PER_PAGE
    );

    const freePages = Math.ceil(freeModels.length / MODELS_PER_PAGE);
    const paidPages = Math.ceil(paidModels.length / MODELS_PER_PAGE);

    const handleModelSelect = (apiName: string) => {
        onSelectModel(apiName);
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="w-[95vw] max-w-[1600px] h-[85vh] p-0 flex flex-col">
                <DialogHeader className="px-6 pt-6 pb-4 flex-shrink-0">
                    <DialogTitle>OpenRouter Models</DialogTitle>
                    <p className="text-sm text-muted-foreground">
                        {models.length} tool-calling models available
                    </p>
                </DialogHeader>

                {/* Search Bar */}
                <div className="px-6 pb-4 flex-shrink-0">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Search models by name..."
                            value={searchQuery}
                            onChange={(e) => {
                                setSearchQuery(e.target.value);
                                setFreeModelsPage(1);
                                setPaidModelsPage(1);
                            }}
                            className="pl-10"
                        />
                    </div>
                </div>

                {/* Two Column Layout */}
                <div className="grid grid-cols-2 gap-4 px-6 pb-4 flex-1 overflow-hidden">
                    {/* Free Models Column */}
                    <div className="flex flex-col border rounded-lg overflow-hidden">
                        <div className="p-3 border-b bg-muted/30 flex-shrink-0">
                            <h3 className="font-semibold text-sm flex items-center gap-2">
                                <span className="text-primary">FREE MODELS</span>
                                <span className="text-xs text-muted-foreground">
                                    ({freeModels.length})
                                </span>
                            </h3>
                        </div>

                        <ScrollArea className="flex-1">
                            <div className="p-2 space-y-1">
                                {freePageModels.length === 0 ? (
                                    <div className="text-center py-8 text-sm text-muted-foreground">
                                        {searchQuery
                                            ? "No free models found"
                                            : "No free models available"}
                                    </div>
                                ) : (
                                    freePageModels.map((model) => (
                                        <button
                                            key={model.apiName}
                                            onClick={() => handleModelSelect(model.apiName)}
                                            className={cn(
                                                "w-full text-left px-3 py-2 rounded-md hover:bg-accent transition-colors",
                                                currentModelName === model.apiName &&
                                                "bg-secondary border border-primary"
                                            )}
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <p className="font-medium text-sm">
                                                        {model.displayName}
                                                    </p>
                                                    {model.description && (
                                                        <p className="text-xs text-muted-foreground line-clamp-1">
                                                            {model.description}
                                                        </p>
                                                    )}
                                                </div>
                                                <PriceBadge dollarSigns={0} />
                                            </div>
                                        </button>
                                    ))
                                )}
                            </div>
                        </ScrollArea>

                        {/* Free Models Pagination */}
                        {freePages > 1 && (
                            <div className="p-2 border-t flex items-center justify-between flex-shrink-0">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        setFreeModelsPage((p) => Math.max(1, p - 1))
                                    }
                                    disabled={freeModelsPage === 1}
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <span className="text-xs text-muted-foreground">
                                    Page {freeModelsPage} of {freePages}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        setFreeModelsPage((p) => Math.min(freePages, p + 1))
                                    }
                                    disabled={freeModelsPage === freePages}
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* Paid Models Column */}
                    <div className="flex flex-col border rounded-lg overflow-hidden">
                        <div className="p-3 border-b bg-muted/30">
                            <h3 className="font-semibold text-sm flex items-center gap-2">
                                <span className="text-primary">PAID MODELS</span>
                                <span className="text-xs text-muted-foreground">
                                    ({paidModels.length})
                                </span>
                            </h3>
                        </div>

                        <ScrollArea className="flex-1">
                            <div className="p-2 space-y-1">
                                {paidPageModels.length === 0 ? (
                                    <div className="text-center py-8 text-sm text-muted-foreground">
                                        {searchQuery
                                            ? "No paid models found"
                                            : "No paid models available"}
                                    </div>
                                ) : (
                                    paidPageModels.map((model) => (
                                        <button
                                            key={model.apiName}
                                            onClick={() => handleModelSelect(model.apiName)}
                                            className={cn(
                                                "w-full text-left px-3 py-2 rounded-md hover:bg-accent transition-colors",
                                                currentModelName === model.apiName &&
                                                "bg-secondary border border-primary"
                                            )}
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <p className="font-medium text-sm">
                                                        {model.displayName}
                                                    </p>
                                                    {model.description && (
                                                        <p className="text-xs text-muted-foreground line-clamp-1">
                                                            {model.description}
                                                        </p>
                                                    )}
                                                </div>
                                                <PriceBadge dollarSigns={model.dollarSigns} />
                                            </div>
                                        </button>
                                    ))
                                )}
                            </div>
                        </ScrollArea>

                        {/* Paid Models Pagination */}
                        {paidPages > 1 && (
                            <div className="p-2 border-t flex items-center justify-between flex-shrink-0">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        setPaidModelsPage((p) => Math.max(1, p - 1))
                                    }
                                    disabled={paidModelsPage === 1}
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <span className="text-xs text-muted-foreground">
                                    Page {paidModelsPage} of {paidPages}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        setPaidModelsPage((p) => Math.min(paidPages, p + 1))
                                    }
                                    disabled={paidModelsPage === paidPages}
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t flex-shrink-0">
                    <p className="text-xs text-muted-foreground text-center">
                        Showing only models with native tool calling support
                    </p>
                </div>
            </DialogContent>
        </Dialog>
    );
}
