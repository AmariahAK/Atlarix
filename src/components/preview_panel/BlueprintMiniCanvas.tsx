/**
 * Read-only Mind Elixir preview for the Diagram tab (AI-pushed blueprint slice).
 * Caps graph size; mounts a single editor instance per component mount.
 */

import { useEffect, useMemo, useRef } from "react";
import MindElixir, { type MindElixirInstance } from "mind-elixir";
// @ts-expect-error - CSS import has no type declarations
import "mind-elixir/style.css";

import type { Blueprint } from "@/shared/blueprint-types";
import {
  blueprintToMindNodes,
  type MindNodeObj,
} from "@/lib/blueprint/blueprint-markdown";
import { cn } from "@/lib/utils";

function cloneTree(node: MindNodeObj): MindNodeObj {
  return {
    ...node,
    children: node.children?.map(cloneTree),
  };
}

const MAX_ROOMS = 48;

function capBlueprint(bp: Blueprint): Blueprint {
  const rooms = (bp.rooms ?? []).filter((r) => !r.hidden).slice(0, MAX_ROOMS);
  const keep = new Set(rooms.map((r) => r.id));
  const edges = (bp.edges ?? [])
    .filter((e) => keep.has(e.from) && keep.has(e.to))
    .slice(0, 96);
  return { ...bp, rooms, edges, envRefs: bp.envRefs ?? [] };
}

export interface BlueprintMiniCanvasProps {
  blueprint: Blueprint;
  className?: string;
  /** Viewport height in CSS pixels */
  heightPx?: number;
}

export function BlueprintMiniCanvas({
  blueprint,
  className,
  heightPx = 320,
}: BlueprintMiniCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mindRef = useRef<MindElixirInstance | null>(null);
  const lastKeyRef = useRef("");

  const capped = useMemo(() => capBlueprint(blueprint), [blueprint]);
  const dataKey = useMemo(() => {
    const r = (capped.rooms ?? []).map((x) => `${x.id}:${x.label}`).join("|");
    const e = (capped.edges ?? []).map((x) => `${x.from}->${x.to}`).join(",");
    return `${r}#${e}`;
  }, [capped]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const mind = new MindElixir({
      el,
      direction: MindElixir.SIDE,
      editable: false,
      contextMenu: false,
      keypress: false,
      allowUndo: false,
    });
    mindRef.current = mind;
    return () => {
      mind.destroy?.();
      mindRef.current = null;
    };
  }, []);

  useEffect(() => {
    const mind = mindRef.current;
    if (!mind) return;
    if (lastKeyRef.current === dataKey) return;
    lastKeyRef.current = dataKey;

    const { root, relations } = blueprintToMindNodes(capped, {
      workspaceName: "Blueprint",
    });
    const tree = cloneTree(root);
    const data = {
      nodeData: tree as Parameters<typeof mind.init>[0]["nodeData"],
      direction: MindElixir.SIDE,
      arrows: relations.map((rel, i) => ({
        id: `rel-${i}-${rel.from}-${rel.to}`,
        from: rel.from,
        to: rel.to,
        label: rel.label,
        style: {
          stroke: rel.label === "inferred" ? "#94a3b8" : "#f59e0b",
          strokeWidth: 2,
          strokeDasharray: rel.label === "inferred" ? "6 4" : undefined,
        },
      })),
    };

    try {
      if (!mind.nodeData) {
        mind.init(data);
      } else {
        mind.refresh(data);
        mind.clearHistory?.();
      }
      mind.toCenter?.();
    } catch {
      /* malformed graph — keep shell */
    }
  }, [capped, dataKey]);

  return (
    <div
      className={cn(
        "relative w-full rounded-md border border-border bg-muted/15 overflow-hidden",
        className,
      )}
    >
      <div
        ref={containerRef}
        className="w-full"
        style={{ height: heightPx, minHeight: 180 }}
      />
    </div>
  );
}
