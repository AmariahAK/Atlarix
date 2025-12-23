import type { Template } from "@/shared/templates";
import { Button } from "@/components/ui/button";

interface TemplateCardProps {
    template: Template;
    onSelect: (template: Template) => void;
}

export function TemplateCard({ template, onSelect }: TemplateCardProps) {
    const getDifficultyColor = (difficulty?: string) => {
        switch (difficulty) {
            case "beginner":
                return "bg-green-500/10 text-green-500 border-green-500/20";
            case "intermediate":
                return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
            case "advanced":
                return "bg-red-500/10 text-red-500 border-red-500/20";
            default:
                return "bg-muted/10 text-muted-foreground border-border/20";
        }
    };

    const getCategoryIcon = (category?: string) => {
        switch (category) {
            case "frontend":
                return "🎨";
            case "backend":
                return "⚙️";
            case "fullstack":
                return "🚀";
            case "mobile":
                return "📱";
            case "api":
                return "🔌";
            case "cli":
                return "⌨️";
            default:
                return "📦";
        }
    };

    return (
        <div className="group relative flex flex-col bg-background border border-border/50 rounded-lg overflow-hidden hover:border-primary/50 hover:shadow-lg transition-all duration-200">
            {/* Image */}
            <div className="relative h-48 bg-muted overflow-hidden">
                <img
                    src={template.imageUrl}
                    alt={template.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    onError={(e) => {
                        e.currentTarget.src = "https://via.placeholder.com/400x300?text=No+Preview";
                    }}
                />
                {template.isOfficial && (
                    <div className="absolute top-2 right-2 px-2 py-1 bg-primary/90 text-primary-foreground text-xs font-semibold rounded-full">
                        Official
                    </div>
                )}
                {template.isExperimental && (
                    <div className="absolute top-2 left-2 px-2 py-1 bg-purple-500/90 text-white text-xs font-semibold rounded-full">
                        Experimental
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="flex flex-col flex-1 p-4">
                {/* Title & Category */}
                <div className="flex items-start gap-2 mb-2">
                    <span className="text-xl">{getCategoryIcon(template.category)}</span>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-semibold text-foreground truncate">
                            {template.title}
                        </h3>
                        {template.category && (
                            <p className="text-xs text-muted-foreground capitalize">
                                {template.category}
                            </p>
                        )}
                    </div>
                </div>

                {/* Description */}
                <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                    {template.description}
                </p>

                {/* Tech Stack */}
                {template.techStack && template.techStack.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                        {template.techStack.slice(0, 4).map((tech) => (
                            <span
                                key={tech}
                                className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-md border border-primary/20"
                            >
                                {tech}
                            </span>
                        ))}
                        {template.techStack.length > 4 && (
                            <span className="px-2 py-0.5 text-muted-foreground text-xs">
                                +{template.techStack.length - 4} more
                            </span>
                        )}
                    </div>
                )}

                {/* Footer */}
                <div className="flex items-center gap-3 mt-auto pt-3 border-t border-border/50">
                    {/* Stars */}
                    {template.stars !== undefined && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <svg
                                className="w-3.5 h-3.5 fill-yellow-500"
                                viewBox="0 0 24 24"
                            >
                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                            </svg>
                            <span>{template.stars.toLocaleString()}</span>
                        </div>
                    )}

                    {/* Difficulty */}
                    {template.difficulty && (
                        <div
                            className={`px-2 py-0.5 text-xs rounded-md border font-medium capitalize ${getDifficultyColor(template.difficulty)}`}
                        >
                            {template.difficulty}
                        </div>
                    )}

                    {/* Use Button */}
                    <Button
                        onClick={() => onSelect(template)}
                        size="sm"
                        className="ml-auto"
                    >
                        Use Template
                    </Button>
                </div>
            </div>
        </div>
    );
}
