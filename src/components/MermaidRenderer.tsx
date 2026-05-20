/**
 * MermaidRenderer
 * ===============
 * Reusable component for rendering Mermaid diagrams with:
 * - Pan/Zoom capability (drag to pan, scroll to zoom)
 * - Dark/light theme support
 * - Error handling
 * - SVG output for export
 */

import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import { useTheme } from "@/contexts/ThemeContext";
import { sanitizeMermaid, repairBracketMermaidLabels } from "@/lib/sanitizeMermaid";

const MERMAID_USER_ERROR_TITLE = "Diagram couldn't render";
const MERMAID_USER_ERROR_BODY =
    "The AI generated a syntax issue. Click Retry to try again, or use 'View Raw Code' to inspect the output.";
import { AlertCircle, RefreshCw, ZoomIn, ZoomOut, Maximize2, Move, Code, ChevronDown, ChevronUp } from "lucide-react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

interface MermaidRendererProps {
    code: string;
    className?: string;
    onRender?: (svg: string) => void;
    onError?: (error: string) => void;
}

// Unique ID counter for mermaid diagrams
let mermaidIdCounter = 0;

/**
 * ErrorOverlay - Friendly message; optional raw error used only for line highlight in raw view
 */
function ErrorOverlay({
    errorRaw,
    code,
    onRetry
}: {
    errorRaw: string | null;
    code: string;
    onRetry: () => void;
}) {
    const [showRawCode, setShowRawCode] = useState(false);

    // Safely extract line number from error like "Lexical error on line 31"
    let errorLine: number | null = null;
    try {
        const lineMatch = errorRaw?.match(/line (\d+)/i);
        if (lineMatch && lineMatch[1]) {
            const parsed = parseInt(lineMatch[1], 10);
            if (!isNaN(parsed) && parsed > 0) {
                errorLine = parsed;
            }
        }
    } catch {
        // Ignore parsing errors
    }

    // Safe code lines
    const codeLines = code?.split('\n') || [];

    return (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-background p-6 overflow-auto">
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 max-w-lg w-full">
                <div className="flex items-start gap-3 mb-3">
                    <AlertCircle className="w-6 h-6 text-destructive flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                        <p className="text-sm font-medium text-destructive mb-1">
                            {MERMAID_USER_ERROR_TITLE}
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            {MERMAID_USER_ERROR_BODY}
                        </p>
                    </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 mb-3">
                    <button
                        onClick={onRetry}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" />
                        Retry
                    </button>
                    {codeLines.length > 0 && (
                        <button
                            onClick={() => setShowRawCode(!showRawCode)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                        >
                            <Code className="w-3 h-3" />
                            {showRawCode ? 'Hide' : 'View'} Raw Code
                            {showRawCode ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>
                    )}
                </div>

                {/* Raw code view */}
                {showRawCode && codeLines.length > 0 && (
                    <div className="mt-3 border-t border-destructive/20 pt-3">
                        <div className="bg-zinc-900 rounded-md p-3 overflow-auto max-h-[300px]">
                            <pre className="text-xs font-mono text-zinc-300">
                                {codeLines.map((line, i) => {
                                    const lineNum = i + 1;
                                    const isErrorLine = errorLine !== null && errorLine === lineNum;
                                    return (
                                        <div
                                            key={i}
                                            className={`flex ${isErrorLine ? 'bg-red-500/20 -mx-3 px-3' : ''}`}
                                        >
                                            <span className={`w-8 text-right pr-3 select-none ${isErrorLine ? 'text-red-400' : 'text-zinc-500'}`}>
                                                {lineNum}
                                            </span>
                                            <span className={isErrorLine ? 'text-red-300' : ''}>
                                                {line || ' '}
                                            </span>
                                        </div>
                                    );
                                })}
                            </pre>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}


export function MermaidRenderer({
    code,
    className = "",
    onRender,
    onError,
}: MermaidRendererProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [isRendering, setIsRendering] = useState(false);
    const { theme } = useTheme();

    // Initialize mermaid with theme
    useEffect(() => {
        mermaid.initialize({
            startOnLoad: false,
            theme: theme === "dark" ? "dark" : "default",
            securityLevel: "loose",
            fontFamily: "Geist, sans-serif",
            themeVariables: theme === "dark"
                ? {
                    primaryColor: "#10B981",
                    primaryTextColor: "#F9FAFB",
                    primaryBorderColor: "#374151",
                    lineColor: "#6B7280",
                    secondaryColor: "#1F2937",
                    tertiaryColor: "#111827",
                    background: "#0F172A",
                    mainBkg: "#1E293B",
                    nodeBorder: "#4B5563",
                    clusterBkg: "#1E293B",
                    titleColor: "#F9FAFB",
                    edgeLabelBackground: "#1E293B",
                }
                : {
                    primaryColor: "#10B981",
                    primaryTextColor: "#111827",
                    primaryBorderColor: "#D1D5DB",
                    lineColor: "#6B7280",
                    secondaryColor: "#F3F4F6",
                    tertiaryColor: "#E5E7EB",
                    background: "#FFFFFF",
                    mainBkg: "#F9FAFB",
                    nodeBorder: "#D1D5DB",
                },
        });
    }, [theme]);

    // Render diagram (retry when container ref not mounted yet — e.g. first paint in chat)
    const renderDiagram = useCallback(async () => {
        if (!code?.trim()) {
            return;
        }

        let el = containerRef.current;
        for (let i = 0; i < 12 && !el; i++) {
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            el = containerRef.current;
        }
        if (!el) {
            return;
        }

        setIsRendering(true);
        setError(null);

        try {
            // Generate unique ID
            const id = `mermaid-${++mermaidIdCounter}`;

            // Clear previous content
            el.innerHTML = "";

            const sanitized = sanitizeMermaid(code);
            let toRender = sanitized;
            try {
                await mermaid.parse(toRender);
            } catch (parseErr) {
                const repaired = repairBracketMermaidLabels(sanitized);
                if (repaired !== sanitized) {
                    try {
                        await mermaid.parse(repaired);
                        toRender = repaired;
                    } catch {
                        throw parseErr;
                    }
                } else {
                    throw parseErr;
                }
            }

            const { svg } = await mermaid.render(id, toRender);

            if (containerRef.current) {
                containerRef.current.innerHTML = svg;

                // Force SVG to be visible with proper dimensions
                const svgElement = containerRef.current.querySelector('svg');
                if (svgElement) {
                    // Let SVG use its natural dimensions for proper zoom/pan
                    svgElement.style.display = 'block';
                    svgElement.style.maxWidth = 'none';
                    svgElement.style.height = 'auto';
                    // Ensure viewBox is preserved for scaling
                    if (!svgElement.getAttribute('viewBox')) {
                        const bbox = svgElement.getBBox?.();
                        if (bbox) {
                            svgElement.setAttribute('viewBox', `0 0 ${bbox.width} ${bbox.height}`);
                        }
                    }
                }

                onRender?.(svg);
            }
        } catch (err) {
            let errorMessage = "Failed to render diagram";
            if (err instanceof Error) {
                errorMessage = err.message || errorMessage;
            } else if (err instanceof Event) {
                const t = err.target as unknown;
                const el = t && typeof t === "object" ? (t as Element) : null;
                const tag =
                    el && "tagName" in el ? String((el as Element).tagName ?? "") : "";
                const src =
                    el && "getAttribute" in el
                        ? (el as Element).getAttribute?.("src") ?? ""
                        : "";
                const href =
                    el && "getAttribute" in el
                        ? (el as Element).getAttribute?.("href") ?? ""
                        : "";
                errorMessage = `Mermaid render failed (Event: ${err.type}${tag ? ` @ <${tag.toLowerCase()}>` : ""}${src ? ` src=${src}` : ""}${href ? ` href=${href}` : ""})`;
            } else if (typeof err === "string" && err.trim()) {
                errorMessage = err.trim();
            } else if (err && typeof err === "object") {
                const maybeMsg =
                    typeof (err as { message?: unknown }).message === "string"
                        ? String((err as { message?: unknown }).message)
                        : "";
                if (maybeMsg.trim()) {
                    errorMessage = maybeMsg.trim();
                }
            }
            console.error("[MermaidRenderer] Error:", err, { errorMessage });
            setError(errorMessage);
            onError?.(MERMAID_USER_ERROR_TITLE);
        } finally {
            setIsRendering(false);
        }
    }, [code, onRender, onError]);

    // Render on code change
    useEffect(() => {
        renderDiagram();
    }, [renderDiagram, theme]);

    return (
        <div className={`relative w-full h-full min-h-[500px] ${className}`}>
            {/* Error Message - Full overlay with raw code view */}
            {error && (
                <ErrorOverlay
                    errorRaw={error}
                    code={code}
                    onRetry={renderDiagram}
                />
            )}

            {/* Loading Spinner - Overlay */}
            {isRendering && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/50 backdrop-blur-[1px]">
                    <div className="flex flex-col items-center gap-2">
                        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        <p className="text-sm text-muted-foreground">Rendering diagram...</p>
                    </div>
                </div>
            )}

            {/* Pan/Zoom Container */}
            <TransformWrapper
                initialScale={0.6}
                minScale={0.1}
                maxScale={4}
                centerOnInit={true}
                wheel={{ step: 0.1 }}
                doubleClick={{ disabled: false, mode: "reset" }}
                panning={{ velocityDisabled: true }}
            >
                {({ zoomIn, zoomOut, resetTransform, centerView }) => (
                    <>
                        {/* Zoom Controls - Fixed position */}
                        <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 bg-background/80 backdrop-blur-sm rounded-lg p-2 border border-border shadow-lg">
                            <button
                                onClick={() => zoomIn(0.3)}
                                className="p-2 hover:bg-accent rounded-md transition-colors"
                                title="Zoom In (or scroll up)"
                            >
                                <ZoomIn className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => zoomOut(0.3)}
                                className="p-2 hover:bg-accent rounded-md transition-colors"
                                title="Zoom Out (or scroll down)"
                            >
                                <ZoomOut className="w-4 h-4" />
                            </button>
                            <div className="w-full h-px bg-border" />
                            <button
                                onClick={() => resetTransform()}
                                className="p-2 hover:bg-accent rounded-md transition-colors"
                                title="Reset View"
                            >
                                <Maximize2 className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => centerView(0.6)}
                                className="p-2 hover:bg-accent rounded-md transition-colors"
                                title="Center View"
                            >
                                <Move className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Diagram Canvas */}
                        <TransformComponent
                            wrapperStyle={{
                                width: '100%',
                                height: '100%',
                                minHeight: '500px',
                                overflow: 'hidden',
                                cursor: 'grab',
                            }}
                            contentStyle={{
                                width: '100%',
                                height: '100%',
                            }}
                        >
                            <div
                                ref={containerRef}
                                className="mermaid-container flex items-center justify-center"
                                style={{
                                    padding: "40px",
                                    opacity: isRendering ? 0.3 : 1,
                                    transition: 'opacity 0.2s ease-in-out',
                                    minWidth: '100%',
                                    minHeight: '500px',
                                }}
                            />
                        </TransformComponent>

                        {/* Pan hint */}
                        <div className="absolute bottom-4 left-4 z-10 text-xs text-muted-foreground bg-background/60 backdrop-blur-sm px-2 py-1 rounded">
                            Drag to pan • Scroll to zoom • Double-click to reset
                        </div>
                    </>
                )}
            </TransformWrapper>
        </div>
    );
}

/**
 * Validate Mermaid syntax without rendering
 */
export async function validateMermaid(code: string): Promise<{ valid: boolean; error?: string }> {
    try {
        await mermaid.parse(sanitizeMermaid(code));
        return { valid: true };
    } catch (err) {
        return {
            valid: false,
            error: err instanceof Error ? err.message : "Invalid syntax",
        };
    }
}

/**
 * Export diagram as SVG string
 */
export async function renderToSvg(code: string): Promise<string> {
    const id = `mermaid-export-${++mermaidIdCounter}`;
    const { svg } = await mermaid.render(id, sanitizeMermaid(code));
    return svg;
}

export default MermaidRenderer;
