import { describe, expect, it } from "vitest";
import { buildGraphEChartsOption } from "./graph-echarts-config";
import type { GraphSpec } from "./graph-spec";

describe("buildGraphEChartsOption", () => {
  it("builds graph series with force layout by default", () => {
    const spec: GraphSpec = {
      nodes: [
        { id: "0", name: "User" },
        { id: "1", name: "Workspace" },
      ],
      edges: [{ source: "0", target: "1" }],
    };
    const option = buildGraphEChartsOption(spec, false);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0]?.type).toBe("graph");
    expect(series[0]?.layout).toBe("force");
    expect(series[0]?.roam).toBe(true);
    expect((series[0]?.data as unknown[])?.length).toBe(2);
    expect((series[0]?.links as unknown[])?.length).toBe(1);
  });

  it("uses none layout when spec requests fixed positions", () => {
    const spec: GraphSpec = {
      layout: "none",
      nodes: [{ id: "a", name: "A", x: 10, y: 20 }],
      edges: [],
    };
    const option = buildGraphEChartsOption(spec, true);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0]?.layout).toBe("none");
  });
});
