export type ChartSpec = {
  type: "bar" | "line";
  title?: string;
  labels: string[];
  values: number[];
};

export function parseChartSpec(raw: string): ChartSpec | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const labels = Array.isArray(data.labels)
      ? data.labels.map((l) => String(l))
      : [];
    const values = Array.isArray(data.values)
      ? data.values.map((v) => Number(v)).filter((n) => !Number.isNaN(n))
      : [];
    if (labels.length === 0 || values.length === 0) return null;
    const type = data.type === "line" ? "line" : "bar";
    return {
      type,
      title: typeof data.title === "string" ? data.title : undefined,
      labels: labels.slice(0, values.length),
      values: values.slice(0, labels.length),
    };
  } catch {
    return null;
  }
}
