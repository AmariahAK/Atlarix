import { useState } from "react";
import type { Template } from "@/shared/templates";

interface TemplateFiltersProps {
    onFilterChange: (filters: FilterState) => void;
}

export interface FilterState {
    category: string;
    framework: string;
    difficulty: string;
    search: string;
}

const CATEGORIES = [
    { value: "all", label: "All Categories" },
    { value: "frontend", label: "Frontend" },
    { value: "backend", label: "Backend" },
    { value: "fullstack", label: "Full Stack" },
    { value: "mobile", label: "Mobile" },
    { value: "api", label: "API" },
    { value: "cli", label: "CLI" },
];

const FRAMEWORKS = [
    { value: "all", label: "All Frameworks" },
    { value: "Next.js", label: "Next.js" },
    { value: "React", label: "React" },
    { value: "Vue", label: "Vue" },
    { value: "FastAPI", label: "FastAPI" },
    { value: "Express", label: "Express" },
    { value: "NestJS", label: "NestJS" },
];

const DIFFICULTIES = [
    { value: "all", label: "All Levels" },
    { value: "beginner", label: "Beginner" },
    { value: "intermediate", label: "Intermediate" },
    { value: "advanced", label: "Advanced" },
];

export function TemplateFilters({ onFilterChange }: TemplateFiltersProps) {
    const [filters, setFilters] = useState<FilterState>({
        category: "all",
        framework: "all",
        difficulty: "all",
        search: "",
    });

    const handleChange = (key: keyof FilterState, value: string) => {
        const newFilters = { ...filters, [key]: value };
        setFilters(newFilters);
        onFilterChange(newFilters);
    };

    return (
        <div className="flex flex-col gap-4 p-4 border-b border-border/50 bg-background">
            {/* Search Bar */}
            <div className="relative">
                <input
                    type="text"
                    placeholder="Search templates..."
                    value={filters.search}
                    onChange={(e) => handleChange("search", e.target.value)}
                    className="w-full px-4 py-2 pl-10 bg-muted border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                />
                <svg
                    className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </div>

            {/* Filter Row */}
            <div className="flex gap-3">
                {/* Category */}
                <select
                    value={filters.category}
                    onChange={(e) => handleChange("category", e.target.value)}
                    className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                    {CATEGORIES.map((cat) => (
                        <option key={cat.value} value={cat.value}>
                            {cat.label}
                        </option>
                    ))}
                </select>

                {/* Framework */}
                <select
                    value={filters.framework}
                    onChange={(e) => handleChange("framework", e.target.value)}
                    className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                    {FRAMEWORKS.map((fw) => (
                        <option key={fw.value} value={fw.value}>
                            {fw.label}
                        </option>
                    ))}
                </select>

                {/* Difficulty */}
                <select
                    value={filters.difficulty}
                    onChange={(e) => handleChange("difficulty", e.target.value)}
                    className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                    {DIFFICULTIES.map((diff) => (
                        <option key={diff.value} value={diff.value}>
                            {diff.label}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}
