/**
 * GraphRenderer — ECharts force/none graph for architecture diagrams.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import * as echarts from "echarts/core";
import { GraphChart } from "echarts/charts";
import {
  TooltipComponent,
  GridComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useTheme } from "@/contexts/ThemeContext";
import {
  parseGraphSpec,
  isLegacyMermaidContent,
  type GraphSpec,
} from "@/lib/visual-artifacts/graph-spec";
import { buildGraphEChartsOption } from "@/lib/visual-artifacts/graph-echarts-config";
import { AlertCircle, RefreshCw, Code, ChevronDown, ChevronUp } from "lucide-react";
import { ArtifactStreamingOverlay } from "@/components/chat/ArtifactStreamingOverlay";

echarts.use([GraphChart, TooltipComponent, GridComponent, CanvasRenderer]);

const GRAPH_DEBOUNCE_MS = 400;

function looksRenderableGraphSource(source: string): boolean {
  const t = source.trim();
  if (t.length < 8) return false;
  return t.includes("{") && t.includes("nodes");
}

interface GraphRendererProps {
  code: string;
  className?: string;
  embedded?: boolean;
  isStreaming?: boolean;
  onRender?: () => void;
  onError?: (error: string) => void;
}

export function GraphRenderer({
  code,
  className = "",
  embedded = false,
  isStreaming = false,
  onRender,
  onError,
}: GraphRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { isDarkMode } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const [hasRendered, setHasRendered] = useState(false);

  const renderGraph = useCallback(
    (spec: GraphSpec) => {
      const el = containerRef.current;
      if (!el) return;
      if (!chartRef.current) {
        chartRef.current = echarts.init(el, isDarkMode ? "dark" : undefined, {
          renderer: "canvas",
        });
      }
      chartRef.current.setOption(buildGraphEChartsOption(spec, isDarkMode), true);
      chartRef.current.resize();
      setHasRendered(true);
      onRender?.();
    },
    [isDarkMode, onRender],
  );

  useEffect(() => {
    if (isStreaming) setHasRendered(false);
  }, [isStreaming, code]);

  useEffect(() => {
    if (!code?.trim()) return;
    if (isStreaming && !looksRenderableGraphSource(code)) return;

    if (isLegacyMermaidContent(code)) {
      const msg = "Legacy Mermaid diagram — regenerate to view as a graph.";
      setError(msg);
      onError?.(msg);
      return;
    }

    const timer = window.setTimeout(() => {
      const spec = parseGraphSpec(code);
      if (!spec) {
        if (isStreaming) return;
        const msg = "Invalid graph JSON — expected nodes and edges.";
        setError(msg);
        onError?.(msg);
        return;
      }
      setError(null);
      try {
        renderGraph(spec);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Graph render failed";
        setError(msg);
        onError?.(msg);
      }
    }, isStreaming ? GRAPH_DEBOUNCE_MS : 0);

    return () => window.clearTimeout(timer);
  }, [code, isStreaming, renderGraph, onError, renderKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => chartRef.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!code?.trim() || error) return;
    const spec = parseGraphSpec(code);
    if (spec) renderGraph(spec);
  }, [isDarkMode, code, error, renderGraph]);

  const minH = embedded ? "min-h-[280px]" : "min-h-[360px]";
  const loading = isStreaming && !error && !hasRendered;

  return (
    <div className={`relative flex flex-col ${className}`}>
      <div
        className={`relative w-full flex-1 ${minH} rounded-md overflow-hidden bg-muted/20`}
      >
        {loading ? <ArtifactStreamingOverlay label="Building graph…" /> : null}
        {error && !loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 p-4 text-center">
            <AlertCircle className="h-8 w-8 text-amber-500" />
            <p className="text-sm font-medium">Diagram couldn&apos;t render</p>
            <p className="text-xs text-muted-foreground max-w-sm">{error}</p>
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              onClick={() => {
                setError(null);
                setRenderKey((k) => k + 1);
              }}
            >
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full min-h-[inherit]" />
      </div>
      <button
        type="button"
        className="mt-1 flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setShowRaw((v) => !v)}
      >
        {showRaw ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        <Code className="h-3 w-3" />
        {showRaw ? "Hide raw JSON" : "View raw JSON"}
      </button>
      {showRaw && (
        <pre className="mt-1 max-h-40 overflow-auto rounded border bg-muted/30 p-2 text-[10px]">
          {code}
        </pre>
      )}
    </div>
  );
}
