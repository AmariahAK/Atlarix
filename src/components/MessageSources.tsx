/**
 * MessageSources
 * ==============
 * Displays clickable source links from web searches (inspired by Perplexica)
 * Shows first 3 sources + a "View more" button if there are additional sources
 * Clicking a source opens a preview panel
 */

import { useState } from "react";
import { extractDomain as getDomain } from "@/lib/format-url";
import { File, ExternalLink, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { IpcClient } from "@/ipc/ipc_client";

/**
 * Open a cited page in Atlarix's own browser tab — an isolated WebContentsView,
 * which is where untrusted third-party pages belong. Falls back to the OS browser if
 * the panel can't be opened, so the action never silently does nothing.
 */
async function openInAppBrowser(url: string): Promise<void> {
    try {
        await IpcClient.getInstance().browserCreateTab(url);
    } catch {
        window.open(url, "_blank");
    }
}

export interface Source {
    title: string;
    url: string;
    content?: string;
    /** Search-result excerpt. Callers pass SourceItem, which names it `snippet`. */
    snippet?: string;
    favicon?: string;
}

interface MessageSourcesProps {
    sources: Source[];
}

export function MessageSources({ sources }: MessageSourcesProps) {
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [selectedSource, setSelectedSource] = useState<Source | null>(null);
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);

    if (!sources || sources.length === 0) return null;

    const displaySources = sources.slice(0, 3);
    const hasMore = sources.length > 3;

    const handleSourceClick = (source: Source, e: React.MouseEvent) => {
        // If Ctrl/Cmd click, open in new tab
        if (e.ctrlKey || e.metaKey) {
            window.open(source.url, "_blank");
        } else {
            // Otherwise show preview
            setSelectedSource(source);
            setIsPreviewOpen(true);
        }
    };

    const getFaviconUrl = (url: string) => {
        if (url === "File") return null;
        return `https://www.google.com/s2/favicons?domain=${getDomain(url)}&sz=32`;
    };

    return (
        <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 my-3">
                {displaySources.map((source, i) => (
                    <button
                        key={i}
                        onClick={(e) => handleSourceClick(source, e)}
                        className="bg-muted/50 hover:bg-muted transition-colors rounded-lg p-3 flex flex-col space-y-2 text-left border border-border/50"
                    >
                        <p className="text-xs font-medium overflow-hidden whitespace-nowrap text-ellipsis">
                            {source.title}
                        </p>
                        <div className="flex flex-row items-center justify-between">
                            <div className="flex flex-row items-center space-x-1.5">
                                {source.url === "File" ? (
                                    <div className="bg-primary/20 flex items-center justify-center w-4 h-4 rounded">
                                        <File size={10} className="text-primary" />
                                    </div>
                                ) : (
                                    <img
                                        src={getFaviconUrl(source.url) || ""}
                                        width={16}
                                        height={16}
                                        alt="favicon"
                                        className="rounded w-4 h-4"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = "none";
                                        }}
                                    />
                                )}
                                <p className="text-xs text-muted-foreground overflow-hidden whitespace-nowrap text-ellipsis">
                                    {getDomain(source.url)}
                                </p>
                            </div>
                            <div className="flex flex-row items-center space-x-1 text-muted-foreground text-xs">
                                <div className="bg-muted-foreground h-1 w-1 rounded-full" />
                                <span>{i + 1}</span>
                            </div>
                        </div>
                    </button>
                ))}

                {hasMore && (
                    <button
                        onClick={() => setIsDialogOpen(true)}
                        className="bg-muted/50 hover:bg-muted transition-colors rounded-lg p-3 flex flex-col justify-center items-center space-y-2 border border-border/50"
                    >
                        <div className="flex flex-row items-center space-x-1">
                            {sources.slice(3, 6).map((source, i) => {
                                const faviconUrl = getFaviconUrl(source.url);
                                return source.url === "File" ? (
                                    <div
                                        key={i}
                                        className="bg-primary/20 flex items-center justify-center w-4 h-4 rounded"
                                    >
                                        <File size={10} className="text-primary" />
                                    </div>
                                ) : faviconUrl ? (
                                    <img
                                        key={i}
                                        src={faviconUrl}
                                        width={16}
                                        height={16}
                                        alt="favicon"
                                        className="rounded w-4 h-4"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = "none";
                                        }}
                                    />
                                ) : null;
                            })}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            +{sources.length - 3} more
                        </p>
                    </button>
                )}
            </div>

            {/* All sources dialog */}
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>All Sources ({sources.length})</DialogTitle>
                    </DialogHeader>
                    <div className="grid grid-cols-2 gap-2 mt-4">
                        {sources.map((source, i) => (
                            <button
                                key={i}
                                onClick={(e) => {
                                    setIsDialogOpen(false);
                                    handleSourceClick(source, e);
                                }}
                                className="bg-muted/50 hover:bg-muted transition-colors rounded-lg p-3 flex flex-col space-y-2 text-left border border-border/50"
                            >
                                <p className="text-xs font-medium overflow-hidden whitespace-nowrap text-ellipsis">
                                    {source.title}
                                </p>
                                <div className="flex flex-row items-center justify-between">
                                    <div className="flex flex-row items-center space-x-1.5">
                                        {source.url === "File" ? (
                                            <div className="bg-primary/20 flex items-center justify-center w-4 h-4 rounded">
                                                <File size={10} className="text-primary" />
                                            </div>
                                        ) : (
                                            <img
                                                src={getFaviconUrl(source.url) || ""}
                                                width={16}
                                                height={16}
                                                alt="favicon"
                                                className="rounded w-4 h-4"
                                                onError={(e) => {
                                                    (e.target as HTMLImageElement).style.display =
                                                        "none";
                                                }}
                                            />
                                        )}
                                        <p className="text-xs text-muted-foreground overflow-hidden whitespace-nowrap text-ellipsis">
                                            {getDomain(source.url)}
                                        </p>
                                    </div>
                                    <div className="flex flex-row items-center space-x-1 text-muted-foreground text-xs">
                                        <div className="bg-muted-foreground h-1 w-1 rounded-full" />
                                        <span>{i + 1}</span>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                </DialogContent>
            </Dialog>

            {/* Source preview panel */}
            <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
                <DialogContent className="max-w-4xl max-h-[90vh] p-0 overflow-hidden">
                    {selectedSource && (
                        <>
                            <DialogHeader className="p-4 border-b border-border">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center space-x-3 flex-1 min-w-0">
                                        {selectedSource.url !== "File" && (
                                            <img
                                                src={getFaviconUrl(selectedSource.url) || ""}
                                                width={20}
                                                height={20}
                                                alt="favicon"
                                                className="rounded flex-shrink-0"
                                                onError={(e) => {
                                                    (e.target as HTMLImageElement).style.display =
                                                        "none";
                                                }}
                                            />
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <DialogTitle className="text-sm font-medium truncate">
                                                {selectedSource.title}
                                            </DialogTitle>
                                            <p className="text-xs text-muted-foreground truncate">
                                                {selectedSource.url}
                                            </p>
                                        </div>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => window.open(selectedSource.url, "_blank")}
                                        className="ml-2"
                                    >
                                        <ExternalLink size={16} />
                                    </Button>
                                </div>
                            </DialogHeader>
                            {/* No iframe here on purpose. The packaged CSP is
                                `frame-src 'self' blob: data:`, so an external URL
                                never loaded — the panel was permanently blank. Even
                                widening it wouldn't help: most doc hosts send
                                X-Frame-Options: DENY, and embedding untrusted pages in
                                the app renderer is a real security regression. The
                                search snippet we already have is a genuine preview,
                                and the in-app browser (an isolated WebContentsView) is
                                the right place to open the page itself. */}
                            <div className="overflow-y-auto max-h-[70vh] p-4 space-y-4">
                                {(selectedSource.snippet ?? selectedSource.content)?.trim() ? (
                                    <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                        {(selectedSource.snippet ?? selectedSource.content)!.trim()}
                                    </p>
                                ) : (
                                    <p className="text-sm text-muted-foreground italic">
                                        No excerpt was returned for this result.
                                    </p>
                                )}
                                <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                                    <Button
                                        size="sm"
                                        onClick={() => {
                                            void openInAppBrowser(selectedSource.url);
                                            setIsPreviewOpen(false);
                                        }}
                                    >
                                        <Globe size={14} className="mr-1.5" />
                                        Open in browser tab
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => window.open(selectedSource.url, "_blank")}
                                    >
                                        <ExternalLink size={14} className="mr-1.5" />
                                        Open externally
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
