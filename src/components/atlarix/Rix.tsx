import { useEffect, useMemo, useRef } from "react";
import { rixSvg, setRixState, type RixState } from "@/lib/rix/rix-svg";

/**
 * Rix, the Atlarix ant (src/lib/rix/rix-svg.ts). The markup is our own, built
 * from constants — no model or user text goes into it — so it is set as HTML.
 * The state is swapped on the drawn SVG so his animation never restarts.
 */
export function Rix({
  state = "rest",
  size = 96,
  detail = "full",
  label = "",
  className,
}: {
  state?: RixState;
  size?: number;
  detail?: "full" | "mid";
  /** Empty marks him decorative. */
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const html = useMemo(() => rixSvg({ state, size: `${size}px`, detail, label }), [size, detail, label]);
  useEffect(() => {
    setRixState(ref.current?.querySelector("svg") ?? null, state);
  }, [state, html]);
  return <span ref={ref} className={className} style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: html }} />;
}
