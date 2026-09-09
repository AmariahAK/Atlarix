import type { EChartsOption } from "echarts";
import type { GraphSpec, GraphNode } from "./graph-spec";

/** Category palette — cycles for nodes without explicit color. */
export const GRAPH_NODE_COLORS = [
  "#7C3AED",
  "#1D9E75",
  "#2563EB",
  "#EA580C",
  "#64748B",
  "#DB2777",
  "#0891B2",
  "#CA8A04",
] as const;

export function graphNodeColor(index: number, explicit?: string): string {
  if (explicit) return explicit;
  return (
    GRAPH_NODE_COLORS[index % GRAPH_NODE_COLORS.length] ?? GRAPH_NODE_COLORS[0]
  );
}

export function buildGraphEChartsOption(
  spec: GraphSpec,
  isDarkMode: boolean,
): EChartsOption {
  const layout = spec.layout ?? "force";
  const textColor = isDarkMode ? "#e2e8f0" : "#1e293b";
  const bg = "transparent";

  const nodes = spec.nodes.map((node: GraphNode, index: number) => {
    const color = graphNodeColor(index, node.itemStyle?.color);
    const hasPosition = node.x != null && node.y != null;
    return {
      id: node.id,
      name: node.name,
      symbolSize: node.symbolSize ?? 60,
      ...(hasPosition ? { x: node.x, y: node.y, fixed: true } : {}),
      itemStyle: { color },
      label: {
        show: true,
        color: node.label?.color ?? "#fff",
        fontSize: 12,
      },
    };
  });

  const edges = spec.edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  const forceConfig =
    layout === "force"
      ? {
          repulsion: 320,
          gravity: 0.08,
          edgeLength: [80, 160],
          layoutAnimation: true,
        }
      : undefined;

  return {
    backgroundColor: bg,
    tooltip: { show: true },
    series: [
      {
        type: "graph",
        layout,
        roam: true,
        draggable: layout === "force",
        force: forceConfig,
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: 8,
        lineStyle: {
          color: isDarkMode ? "#64748b" : "#94a3b8",
          width: 1.5,
          curveness: layout === "force" ? 0.15 : 0,
        },
        emphasis: {
          focus: "adjacency",
          lineStyle: { width: 2.5 },
        },
        label: { position: "inside" },
        data: nodes,
        links: edges,
      },
    ],
    textStyle: { color: textColor },
  };
}
