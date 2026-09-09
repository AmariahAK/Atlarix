import { useCallback, useEffect, useRef, useState } from "react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { ArtifactStreamingOverlay } from "@/components/chat/ArtifactStreamingOverlay";

const transformer = new Transformer();
const MAX_MARKMAP_NODES = 400;
const MARKMAP_DEBOUNCE_MS = 300;

type MarkmapRoot = { children?: MarkmapRoot[] };

function countMarkmapNodes(node: MarkmapRoot): number {
  let n = 1;
  for (const child of node.children ?? []) {
    n += countMarkmapNodes(child);
  }
  return n;
}

interface MarkmapRendererProps {
  content: string;
  className?: string;
  /** When true, fill parent artifact card instead of enforcing standalone min-height */
  isStreaming?: boolean;
  embedded?: boolean;
}

function hslVar(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw ? `hsl(${raw})` : fallback;
}

function markmapPalette(theme: "light" | "dark") {
  const isDark = theme === "dark";
  if (isDark) {
    return {
      fg: "#f4f4f5",
      primary: "#4ade80",
      muted: "#d4d4d8",
      link: "#86efac",
      linkStroke: "#a1a1aa",
    };
  }
  return {
    fg: hslVar("--foreground", "#111827"),
    primary: hslVar("--primary", "#059669"),
    muted: hslVar("--muted-foreground", "#6b7280"),
    link: hslVar("--primary", "#047857"),
    linkStroke: "#9ca3af",
  };
}

function markmapThemeCss(
  theme: "light" | "dark",
  palette: ReturnType<typeof markmapPalette>,
) {
  if (theme === "dark") {
    return `
      .markmap-root.markmap-theme-dark .markmap {
        --markmap-text-color: ${palette.fg};
        --markmap-circle-open-bg: #27272a;
        --markmap-a-color: ${palette.primary};
        --markmap-a-hover-color: ${palette.link};
        --markmap-code-color: #e4e4e7;
        --markmap-code-bg: #3f3f46;
        --markmap-highlight-bg: #422006;
        --markmap-highlight-node-bg: rgba(74, 222, 128, 0.15);
        color: ${palette.fg};
      }
      .markmap-root.markmap-theme-dark .markmap path.markmap-link {
        stroke: ${palette.linkStroke};
        stroke-opacity: 0.9;
      }
      .markmap-root.markmap-theme-dark .markmap-foreign,
      .markmap-root.markmap-theme-dark .markmap-foreign div,
      .markmap-root.markmap-theme-dark .markmap-foreign p,
      .markmap-root.markmap-theme-dark .markmap-foreign span,
      .markmap-root.markmap-theme-dark .markmap-foreign a {
        color: ${palette.fg} !important;
      }
      .markmap-root.markmap-theme-dark .markmap-foreign a {
        color: ${palette.link} !important;
      }
      .markmap-root.markmap-theme-dark .markmap text {
        fill: ${palette.fg};
      }
    `;
  }
  return `
    .markmap-root.markmap-theme-light .markmap {
      --markmap-text-color: ${palette.fg};
      --markmap-a-color: ${palette.primary};
      color: ${palette.fg};
    }
    .markmap-root.markmap-theme-light .markmap path.markmap-link {
      stroke: ${palette.linkStroke};
    }
    .markmap-root.markmap-theme-light .markmap text {
      fill: ${palette.fg};
    }
  `;
}
export function MarkmapRenderer({
  content,
  className = "",
  embedded = false,
  isStreaming = false,
}: MarkmapRendererProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const markmapRef = useRef<Markmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasRendered, setHasRendered] = useState(false);
  const { theme } = useTheme();
  const resolvedTheme: "light" | "dark" = theme === "dark" ? "dark" : "light";

  useEffect(() => {
    if (isStreaming) setHasRendered(false);
  }, [isStreaming, content]);

  const destroyMarkmap = useCallback(() => {
    markmapRef.current?.destroy();
    markmapRef.current = null;
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !content?.trim()) {
      destroyMarkmap();
      return;
    }

    setError(null);
    const palette = markmapPalette(resolvedTheme);
    const timer = setTimeout(() => {
      try {
        destroyMarkmap();
        const { root } = transformer.transform(content);
        const nodeCount = countMarkmapNodes(root as MarkmapRoot);
        if (nodeCount > MAX_MARKMAP_NODES) {
          setError(
            `Mind map too large (${nodeCount} nodes; max ${MAX_MARKMAP_NODES}). Split into smaller sections.`,
          );
          return;
        }
        markmapRef.current = Markmap.create(svg, {
          zoom: true,
          pan: true,
          color: (node: { state?: { depth?: number } }) => {
            const depth = node.state?.depth ?? 0;
            if (depth === 0) return palette.primary;
            if (depth === 1) return palette.fg;
            return palette.muted;
          },
        });
        setHasRendered(true);
        markmapRef.current.setData(root);
        requestAnimationFrame(() => {
          void markmapRef.current?.fit();
        });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to render mind map";
        setError(msg);
        destroyMarkmap();
      }
    }, MARKMAP_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      destroyMarkmap();
    };
  }, [content, theme, destroyMarkmap, isStreaming]);

  const handleZoomIn = () => {
    void markmapRef.current?.rescale(1.2);
  };
  const handleZoomOut = () => {
    void markmapRef.current?.rescale(0.8);
  };
  const handleFit = () => {
    void markmapRef.current?.fit();
  };

  if (error) {
    return (
      <pre className="not-prose overflow-auto rounded-lg bg-muted/50 px-4 py-3 text-xs font-mono text-foreground">
        {content}
      </pre>
    );
  }

  const bgClass = theme === "dark" ? "bg-zinc-900/80" : "bg-muted/30";
  const palette = markmapPalette(resolvedTheme);
  const themeClass =
    theme === "dark" ? "markmap-theme-dark" : "markmap-theme-light";
  const loading = isStreaming && !error && !hasRendered;

  return (
    <div
      className={`markmap-root ${themeClass} not-prose relative w-full overflow-hidden ${embedded ? "h-full min-h-0 border-0 rounded-none" : "rounded-lg border border-border/50"} ${bgClass} ${className}`}
      style={embedded ? undefined : { minHeight: 280 }}
    >
      {loading ? <ArtifactStreamingOverlay label="Building mind map…" /> : null}
      <style>{markmapThemeCss(resolvedTheme, palette)}</style>
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 rounded-lg border border-border bg-background/80 p-1 shadow-sm backdrop-blur-sm">
        <button
          type="button"
          onClick={handleZoomIn}
          className="rounded-md p-1.5 transition-colors hover:bg-accent"
          title="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          className="rounded-md p-1.5 transition-colors hover:bg-accent"
          title="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleFit}
          className="rounded-md p-1.5 transition-colors hover:bg-accent"
          title="Fit to view"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
      <svg
        ref={svgRef}
        className="markmap h-full w-full"
        style={embedded ? undefined : { minHeight: 280 }}
      />
    </div>
  );
}
