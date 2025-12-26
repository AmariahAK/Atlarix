/**
 * MermaidRenderer
 * ===============
 * Reusable component for rendering Mermaid diagrams with:
 * - Dark/light theme support
 * - Error handling
 * - SVG output for export
 */

import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import { useTheme } from "@/contexts/ThemeContext";
import { AlertCircle, RefreshCw } from "lucide-react";

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
        if (!containerRef.current || !code.trim()) {
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
                onRender?.(svg);
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Failed to render diagram";
            setError(errorMessage);
            onError?.(errorMessage);
            console.error("[MermaidRenderer] Error:", err);
        } finally {
            setIsRendering(false);
        }
    }, [code, onRender, onError]);

    // Render on code change
    useEffect(() => {
        renderDiagram();
    }, [renderDiagram, theme]);

    // Error state
    if (error) {
        return (
            <div className={`flex flex-col items-center justify-center p-6 ${className}`}>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 max-w-md text-center">
                    <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
                    <p className="text-sm font-medium text-red-500 mb-2">
                        Invalid Mermaid Syntax
                    </p>
                    <p className="text-xs text-red-400 mb-3 font-mono break-all">
                        {error}
                    </p>
                    <button
                        onClick={renderDiagram}
                        className="flex items-center gap-1 mx-auto px-3 py-1.5 text-xs rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" />
                        Retry
                    </button>
                </div>

                {/* Show raw code fallback */}
                <pre className="mt-4 p-3 bg-muted/30 rounded-lg text-xs font-mono text-muted-foreground max-w-full overflow-x-auto">
                    {code}
                </pre>
            </div>
        );
    }

    // Loading state
    if (isRendering && !containerRef.current?.innerHTML) {
        return (
            <div className={`flex items-center justify-center p-6 ${className}`}>
                <div className="flex flex-col items-center gap-2">
                    <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-muted-foreground">Rendering diagram...</p>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className={`mermaid-container w-full overflow-auto ${className}`}
            style={{ minHeight: "100px" }}
        />
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
