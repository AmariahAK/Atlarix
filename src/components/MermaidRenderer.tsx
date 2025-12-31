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
import { AlertCircle, RefreshCw, ZoomIn, ZoomOut, Maximize2, Move } from "lucide-react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

interface MermaidRendererProps {
    code: string;
    className?: string;
    onRender?: (svg: string) => void;
    onError?: (error: string) => void;
}

// Unique ID counter for mermaid diagrams
let mermaidIdCounter = 0;

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

    // Render diagram
    const renderDiagram = useCallback(async () => {
        if (!containerRef.current || !code?.trim()) {
            return;
        }

        setIsRendering(true);
        setError(null);

        try {
            // Generate unique ID
            const id = `mermaid-${++mermaidIdCounter}`;

            // Clear previous content
            containerRef.current.innerHTML = "";

            // Validate syntax first
            await mermaid.parse(code);

            // Render the diagram
            const { svg } = await mermaid.render(id, code);

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
            const errorMessage = err instanceof Error ? err.message : "Failed to render diagram";
            console.error("[MermaidRenderer] Error:", err);
            setError(errorMessage);
            onError?.(errorMessage);
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
            {/* Error Message */}
            {error && (
                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-background/90 p-6">
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 max-w-md text-center">
                        <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-2" />
                        <p className="text-sm font-medium text-destructive mb-2">
                            Invalid Mermaid Syntax
                        </p>
                        <p className="text-xs text-destructive/80 mb-3 font-mono break-all">
                            {error}
                        </p>
                        <button
                            onClick={renderDiagram}
                            className="flex items-center gap-1 mx-auto px-3 py-1.5 text-xs rounded-md bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
                        >
                            <RefreshCw className="w-3 h-3" />
                            Retry
                        </button>
                    </div>
                </div>
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
        await mermaid.parse(code);
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
    const { svg } = await mermaid.render(id, code);
    return svg;
}

export default MermaidRenderer;
