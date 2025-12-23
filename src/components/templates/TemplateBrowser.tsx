import { useState, useEffect } from "react";
import type { Template } from "@/shared/templates";
import { TemplateCard } from "./TemplateCard";
import { TemplateFilters, type FilterState } from "./TemplateFilters";
import { IpcClient } from "@/ipc/ipc_client";

interface TemplateBrowserProps {
    onSelect: (template: Template) => void;
    onClose?: () => void;
}

export function TemplateBrowser({ onSelect, onClose }: TemplateBrowserProps) {
    const [allTemplates, setAllTemplates] = useState<Template[]>([]);
    const [filteredTemplates, setFilteredTemplates] = useState<Template[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Fetch templates on mount
    useEffect(() => {
        fetchTemplates();
    }, []);

    const fetchTemplates = async () => {
        try {
            setLoading(true);
            const templates = await IpcClient.getInstance().listTemplates();
            setAllTemplates(templates);
            setFilteredTemplates(templates);
        } catch (err) {
            console.error("Failed to fetch templates:", err);
            setError("Failed to load templates. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    const handleFilterChange = (filters: FilterState) => {
        let filtered = [...allTemplates];

        // Category filter
        if (filters.category !== "all") {
            filtered = filtered.filter((t) => t.category === filters.category);
        }

        // Framework filter
        if (filters.framework !== "all") {
            filtered = filtered.filter(
                (t) =>
                    t.techStack &&
                    t.techStack.some((tech) =>
                        tech.toLowerCase().includes(filters.framework.toLowerCase())
                    )
            );
        }

        // Difficulty filter
        if (filters.difficulty !== "all") {
            filtered = filtered.filter((t) => t.difficulty === filters.difficulty);
        }

        // Search filter
        if (filters.search.trim()) {
            const search = filters.search.toLowerCase();
            filtered = filtered.filter(
                (t) =>
                    t.title.toLowerCase().includes(search) ||
                    t.description.toLowerCase().includes(search) ||
                    t.techStack?.some((tech) => tech.toLowerCase().includes(search))
            );
        }

        setFilteredTemplates(filtered);
    };

    const handleSelect = (template: Template) => {
        onSelect(template);
        onClose?.();
    };

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
                <div>
                    <h2 className="text-2xl font-bold text-foreground">Choose a Template</h2>
                    <p className="text-sm text-muted-foreground mt-1">
                        {filteredTemplates.length} template{filteredTemplates.length !== 1 ? "s" : ""} available
                    </p>
                </div>
                {onClose && (
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-muted rounded-lg transition-colors"
                        aria-label="Close"
                    >
                        <svg
                            className="w-5 h-5 text-muted-foreground"
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                )}
            </div>

            {/* Filters */}
            <TemplateFilters onFilterChange={handleFilterChange} />

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
                {loading ? (
                    <div className="flex items-center justify-center h-64">
                        <div className="flex flex-col items-center gap-3">
                            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                            <p className="text-sm text-muted-foreground">Loading templates...</p>
                        </div>
                    </div>
                ) : error ? (
                    <div className="flex items-center justify-center h-64">
                        <div className="flex flex-col items-center gap-3 max-w-md text-center">
                            <svg
                                className="w-12 h-12 text-red-500"
                                fill="none"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <p className="text-sm text-muted-foreground">{error}</p>
                            <button
                                onClick={fetchTemplates}
                                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                            >
                                Retry
                            </button>
                        </div>
                    </div>
                ) : filteredTemplates.length === 0 ? (
                    <div className="flex items-center justify-center h-64">
                        <div className="flex flex-col items-center gap-3 max-w-md text-center">
                            <svg
                                className="w-12 h-12 text-muted-foreground"
                                fill="none"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <p className="text-sm text-muted-foreground">
                                No templates match your filters. Try adjusting your search.
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filteredTemplates.map((template) => (
                            <TemplateCard
                                key={template.id}
                                template={template}
                                onSelect={handleSelect}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
