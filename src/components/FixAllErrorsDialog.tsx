/**
 * FixAllErrorsDialog
 * ==================
 * Preview dialog for fixing multiple errors with AI.
 * Features:
 * - Auto-grouped by error type (structural > build > type > runtime)
 * - Checkbox selection for each error
 * - User context input field
 * - Send selected errors to AI
 */

import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Sparkles, AlertTriangle, AlertCircle, Bug, Layers } from 'lucide-react';
import { type ParsedError } from '@/lib/devServerErrorParser';
import { cn } from '@/lib/utils';

interface FixAllErrorsDialogProps {
    isOpen: boolean;
    onClose: () => void;
    errors: ParsedError[];
    onSubmit: (selectedErrors: ParsedError[], context: string) => void;
}

// Error type priority for sorting (lower = higher priority)
const ERROR_TYPE_PRIORITY: Record<ParsedError['type'], number> = {
    structural: 0,
    build: 1,
    type: 2,
    syntax: 3,
    import: 4,
    runtime: 5,
    lint: 6,
};

// Error type display config
const ERROR_TYPE_CONFIG: Record<ParsedError['type'], { icon: typeof AlertTriangle; color: string; label: string }> = {
    structural: { icon: Layers, color: 'text-purple-400 bg-purple-500/10 border-purple-500/30', label: 'STRUCTURAL' },
    build: { icon: AlertCircle, color: 'text-red-400 bg-red-500/10 border-red-500/30', label: 'BUILD' },
    type: { icon: AlertTriangle, color: 'text-orange-400 bg-orange-500/10 border-orange-500/30', label: 'TYPE' },
    syntax: { icon: AlertTriangle, color: 'text-red-400 bg-red-500/10 border-red-500/30', label: 'SYNTAX' },
    import: { icon: AlertCircle, color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30', label: 'IMPORT' },
    runtime: { icon: Bug, color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30', label: 'RUNTIME' },
    lint: { icon: AlertTriangle, color: 'text-blue-400 bg-blue-500/10 border-blue-500/30', label: 'LINT' },
};

export function FixAllErrorsDialog({ isOpen, onClose, errors, onSubmit }: FixAllErrorsDialogProps) {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(errors.map(e => e.id)));
    const [context, setContext] = useState('');

    // Group and sort errors by type
    const groupedErrors = useMemo(() => {
        const groups: Record<ParsedError['type'], ParsedError[]> = {
            structural: [],
            build: [],
            type: [],
            syntax: [],
            import: [],
            runtime: [],
            lint: [],
        };

        errors.forEach(error => {
            groups[error.type].push(error);
        });

        // Return only non-empty groups, sorted by priority
        return Object.entries(groups)
            .filter(([_type, errs]) => errs.length > 0)
            .sort(([a], [b]) =>
                ERROR_TYPE_PRIORITY[a as ParsedError['type']] - ERROR_TYPE_PRIORITY[b as ParsedError['type']]
            ) as [ParsedError['type'], ParsedError[]][];
    }, [errors]);

    const toggleError = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const toggleGroup = (type: ParsedError['type']) => {
        const groupErrors = errors.filter(e => e.type === type);
        const allSelected = groupErrors.every(e => selectedIds.has(e.id));

        setSelectedIds(prev => {
            const next = new Set(prev);
            groupErrors.forEach(e => {
                if (allSelected) {
                    next.delete(e.id);
                } else {
                    next.add(e.id);
                }
            });
            return next;
        });
    };

    const handleSubmit = () => {
        const selectedErrors = errors.filter(e => selectedIds.has(e.id));
        if (selectedErrors.length > 0) {
            onSubmit(selectedErrors, context);
            onClose();
        }
    };

    const selectedCount = selectedIds.size;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-primary" />
                        Fix {selectedCount} Error{selectedCount !== 1 ? 's' : ''} with AI
                    </DialogTitle>
                </DialogHeader>

                {/* Error List */}
                <div className="flex-1 overflow-auto space-y-4 py-4">
                    {groupedErrors.map(([type, groupErrors]) => {
                        const config = ERROR_TYPE_CONFIG[type];
                        const Icon = config.icon;
                        const allSelected = groupErrors.every(e => selectedIds.has(e.id));
                        const someSelected = groupErrors.some(e => selectedIds.has(e.id));

                        return (
                            <div key={type} className="space-y-2">
                                {/* Group Header */}
                                <div
                                    className="flex items-center gap-2 cursor-pointer group"
                                    onClick={() => toggleGroup(type)}
                                >
                                    <Checkbox
                                        checked={allSelected}
                                        // @ts-ignore - indeterminate is valid HTML attribute
                                        data-state={someSelected && !allSelected ? 'indeterminate' : allSelected ? 'checked' : 'unchecked'}
                                        className="data-[state=indeterminate]:bg-primary/50"
                                    />
                                    <Icon className={cn("w-4 h-4", config.color.split(' ')[0])} />
                                    <span className={cn(
                                        "text-xs px-2 py-0.5 rounded border font-bold tracking-wider",
                                        config.color
                                    )}>
                                        {config.label} ({groupErrors.length})
                                    </span>
                                </div>

                                {/* Group Errors */}
                                <div className="ml-6 space-y-1">
                                    {groupErrors.map(error => (
                                        <div
                                            key={error.id}
                                            className={cn(
                                                "flex items-start gap-3 p-2 rounded border cursor-pointer transition-colors",
                                                selectedIds.has(error.id)
                                                    ? "bg-primary/5 border-primary/30"
                                                    : "bg-zinc-900/50 border-zinc-800 hover:border-zinc-700"
                                            )}
                                            onClick={() => toggleError(error.id)}
                                        >
                                            <Checkbox
                                                checked={selectedIds.has(error.id)}
                                                className="mt-0.5"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm text-zinc-300 font-mono truncate">
                                                    {error.message}
                                                </p>
                                                {error.file && (
                                                    <p className="text-xs text-zinc-500 mt-0.5">
                                                        📁 {error.file}{error.line ? `:${error.line}` : ''}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Context Input */}
                <div className="space-y-2 border-t border-zinc-800 pt-4">
                    <label className="text-sm text-zinc-400">
                        Additional Context (optional)
                    </label>
                    <Textarea
                        value={context}
                        onChange={(e) => setContext(e.target.value)}
                        placeholder="E.g., 'These errors appeared after I added the recipe functionality...'"
                        className="resize-none h-20 text-sm"
                    />
                </div>

                <DialogFooter className="mt-4">
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={selectedCount === 0}
                        className="gap-2"
                    >
                        <Sparkles className="w-4 h-4" />
                        Fix {selectedCount} Error{selectedCount !== 1 ? 's' : ''}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
