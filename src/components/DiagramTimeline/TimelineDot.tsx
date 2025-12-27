/**
 * TimelineDot Component
 * 
 * Visual dot on the timeline bar representing a snapshot.
 * Shows diff indicators (architecture: blue, dependencies: green, no change: gray).
 */

import { cn } from "@/lib/utils";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "../ui/tooltip";
import { format } from "date-fns";

interface TimelineDotProps {
    id: number;
    createdAt: Date;
    architectureChanged: boolean;
    dependenciesChanged: boolean;
    annotation?: string | null;
    isProtected: boolean;
    onClick: () => void;
    isSelected?: boolean;
    position?: number; // 0-100 percentage position
}

export function TimelineDot({
    id,
    createdAt,
    architectureChanged,
    dependenciesChanged,
    annotation,
    isProtected,
    onClick,
    isSelected,
    position = 50,
}: TimelineDotProps) {
    // Determine dot color based on changes
    const getDotClass = () => {
        if (architectureChanged && dependenciesChanged) {
            return "bg-gradient-to-r from-blue-500 to-green-500 border-white";
        }
        if (architectureChanged) {
            return "bg-blue-500 border-blue-300"; // 🔵 Architecture changed
        }
        if (dependenciesChanged) {
            return "bg-green-500 border-green-300"; // 🟢 Dependencies changed
        }
        return "bg-gray-400 border-gray-300"; // ⚪ No change
    };

    const formattedDate = format(new Date(createdAt), "MMM d, h:mm a");

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        onClick={onClick}
                        className={cn(
                            "absolute w-3 h-3 rounded-full border-2 transition-all cursor-pointer",
                            "hover:scale-125 hover:ring-2 hover:ring-primary/30",
                            getDotClass(),
                            isSelected && "ring-2 ring-primary scale-125",
                            isProtected && "ring-1 ring-yellow-400" // Protected snapshots have yellow ring
                        )}
                        style={{
                            left: `${position}%`,
                            top: "50%",
                            transform: "translate(-50%, -50%)",
                        }}
                    />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                    <div className="space-y-1">
                        <p className="font-medium text-sm">{formattedDate}</p>
                        {annotation && (
                            <p className="text-xs text-muted-foreground italic">"{annotation}"</p>
                        )}
                        <div className="flex gap-2 text-xs">
                            {architectureChanged && (
                                <span className="text-blue-500">🔵 Architecture</span>
                            )}
                            {dependenciesChanged && (
                                <span className="text-green-500">🟢 Dependencies</span>
                            )}
                            {!architectureChanged && !dependenciesChanged && (
                                <span className="text-gray-400">⚪ No changes</span>
                            )}
                        </div>
                        {isProtected && (
                            <p className="text-xs text-yellow-500">🔒 Protected</p>
                        )}
                    </div>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
