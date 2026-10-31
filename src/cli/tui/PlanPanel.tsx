/** @jsxImportSource @opentui/react */
/**
 * The plan, pinned above the prompt box while it waits to be built — readable
 * WHILE you decide or type what to change, and redrawn as Atlarix revises it.
 * It replaced a "Plan ready" chooser that covered the conversation with the
 * plan itself out of sight (owner, 2026-10-05: "we cant even see or read the
 * plan and this popup appears").
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Prose } from "./Prose";
import { color, glyph } from "./theme";

export interface PinnedPlan {
  id: string;
  title: string;
  status: string;
  content: string;
}

/**
 * The hint beside "Build it", as much of it as fits: at ~72 columns the whole
 * line pushed the button onto two lines ("Build / it").
 */
export function planHint(width: number): string {
  const room = width - 6 - 10; // the panel's border and padding, then the button
  const full = "  /build · type below to change it · pgup/pgdn scroll · esc hide";
  const short = "  /build · pgup/pgdn scroll · esc hide";
  return full.length <= room ? full : short.length <= room ? short : room >= 12 ? "  esc hide" : "";
}

/** Scroll the pinned plan from the keyboard (PgUp/PgDn); null when none is shown. */
export type PlanScroll = (rows: number) => void;

export function PlanPanel({
  plan,
  width,
  maxHeight,
  plain,
  onBuild,
  scrollRef,
}: {
  plan: PinnedPlan;
  width: number;
  maxHeight: number;
  plain?: boolean;
  onBuild: () => void;
  scrollRef: MutableRefObject<PlanScroll | null>;
}) {
  const box = useRef<ScrollBoxRenderable | null>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    scrollRef.current = (rows) => {
      if (box.current) box.current.scrollTop = Math.max(0, box.current.scrollTop + rows);
    };
    return () => {
      scrollRef.current = null;
    };
  }, [scrollRef]);
  // As long as the plan is short, the panel is only as tall as it.
  const lines = plan.content.split("\n").length + 2;
  const height = Math.max(4, Math.min(maxHeight, lines));
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={color.accent}
      backgroundColor={color.panel}
      title={` ${glyph.reply} Plan · ${plan.title} · ${plan.status === "building" ? "stopped part-way, /build continues" : "ready to build"} `}
      titleAlignment="left"
      titleColor={color.accentSoft}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
    >
      <scrollbox ref={box} height={height}>
        <Prose text={plan.content} width={Math.max(20, width - 6)} plain={plain} />
      </scrollbox>
      <box flexDirection="row" marginTop={1}>
        <box
          flexShrink={0}
          backgroundColor={hover ? color.accentSoft : color.accent}
          paddingLeft={1}
          paddingRight={1}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={(e) => {
            e.stopPropagation();
            onBuild();
          }}
        >
          <text fg={color.bg}>
            <b>{plan.status === "building" ? "Continue" : "Build it"}</b>
          </text>
        </box>
        <text fg={color.faint}>{planHint(width)}</text>
      </box>
    </box>
  );
}
