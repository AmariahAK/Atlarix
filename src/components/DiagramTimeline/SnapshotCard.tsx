/**
 * SnapshotCard Component
 * 
 * Displays details of a single diagram snapshot.
 * Shows diagram preview, trigger, annotation, and action buttons.
 */

import { useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import {
    Camera,
    Calendar,
    FileText,
    Shield,
    Trash2,
    Edit,
    Eye,
} from "lucide-react";
import { format } from "date-fns";
import { GraphRenderer } from "../GraphRenderer";
import { cn } from "@/lib/utils";

interface SnapshotCardProps {
    id: number;
    architecture: string;
    dependencies?: string | null;
    trigger: "auto" | "ai_change" | "user_request" | "structural";
    summary?: string | null;
    annotation?: string | null;
    filesChanged?: string[] | null;
    isProtected: boolean;
    createdAt: Date;
    onView?: () => void;
    onAnnotate?: () => void;
    onDelete?: () => void;
    className?: string;
}

const TRIGGER_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
    auto: { label: "Auto", variant: "secondary" },
    ai_change: { label: "AI Change", variant: "default" },
    user_request: { label: "Manual", variant: "outline" },
    structural: { label: "Structural", variant: "default" },
};

export function SnapshotCard({
    id,
    architecture,
    dependencies,
    trigger,
    summary,
    annotation,
    filesChanged,
    isProtected,
    createdAt,
    onView,
    onAnnotate,
    onDelete,
    className,
}: SnapshotCardProps) {
    const [expanded, setExpanded] = useState(false);
    const triggerInfo = TRIGGER_LABELS[trigger] || TRIGGER_LABELS.auto;
    const formattedDate = format(new Date(createdAt), "MMM d, yyyy 'at' h:mm a");

    return (
        <Card className={cn("transition-all hover:shadow-md", className)}>
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Camera className="w-4 h-4 text-muted-foreground" />
                        <CardTitle className="text-sm font-medium">
                            Snapshot #{id}
                        </CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge variant={triggerInfo.variant} className="text-xs">
                            {triggerInfo.label}
                        </Badge>
                        {isProtected && (
                            <Badge variant="outline" className="text-xs text-yellow-600 border-yellow-400">
                                <Shield className="w-3 h-3 mr-1" />
                                Protected
                            </Badge>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Calendar className="w-3 h-3" />
                    {formattedDate}
                </div>
            </CardHeader>

            <CardContent className="space-y-3">
                {/* Summary or Annotation */}
                {(summary || annotation) && (
                    <p className="text-sm text-muted-foreground">
                        {annotation ? (
                            <span className="italic">"{annotation}"</span>
                        ) : (
                            summary
                        )}
                    </p>
                )}

                {/* Files Changed */}
                {filesChanged && filesChanged.length > 0 && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <FileText className="w-3 h-3" />
                        <span>{filesChanged.length} files changed</span>
                    </div>
                )}

                {/* Diagram Preview (collapsed by default) */}
                <div
                    className={cn(
                        "border rounded-lg overflow-hidden transition-all",
                        expanded ? "max-h-[400px]" : "max-h-[100px]"
                    )}
                >
                    <div
                        className="cursor-pointer"
                        onClick={() => setExpanded(!expanded)}
                    >
                        <GraphRenderer
                            code={architecture}
                            className="w-full h-auto"
                            embedded
                        />
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onView}
                        className="flex-1"
                    >
                        <Eye className="w-3 h-3 mr-1" />
                        View
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onAnnotate}
                    >
                        <Edit className="w-3 h-3 mr-1" />
                        Annotate
                    </Button>
                    {!isProtected && onDelete && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onDelete}
                            className="text-destructive hover:text-destructive"
                        >
                            <Trash2 className="w-3 h-3" />
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
