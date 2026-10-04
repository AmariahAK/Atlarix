/** @jsxImportSource @opentui/react */
/**
 * Draws the top dialog (dialogs.ts). Keys are App's; this only draws.
 *
 *   DialogOverlay  a panel centred over a dimmed screen (opencode's dialogs):
 *                  /model, /connect, /mcp, /resume, /tasks …
 *   DialogPanel    the same panel inline above the prompt box, for what is
 *                  ABOUT the conversation and must not hide it: the agent's
 *                  questions (`asking`).
 *
 * Title on the left, "esc" on the right; sections in the accent; the chosen row
 * on an accent band; badges right-aligned; the footer lists what keys do, as
 * "Connect provider ctrl+a".
 */
import { RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { DialogView, Hint, Line, ListItem, Tone } from "./dialogs";
import { Prose } from "./Prose";
import { color } from "./theme";

const toneColor = (t: Tone | undefined): string =>
  t === "accent"
    ? color.accent
    : t === "muted"
      ? color.muted
      : t === "warn"
        ? color.warn
        : t === "error"
          ? color.error
          : color.text;

/** The screen behind an open dialog: dimmed, still visible. */
const BACKDROP = RGBA.fromInts(0, 0, 0, 150);

function Lines({ lines }: { lines: Line[] }) {
  return (
    <>
      {lines.map((l, i) => (
        <text key={i} fg={toneColor(l.tone)}>
          {l.bold ? <b>{l.text || " "}</b> : l.text || " "}
        </text>
      ))}
    </>
  );
}

function Header({ title, asking }: { title: string; asking?: boolean }) {
  // A long title wraps in its own column instead of running into "esc".
  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} gap={2}>
      <text fg={asking ? color.accent : color.white} flexShrink={1}>
        <b>{asking ? `? ${title}` : title}</b>
      </text>
      <text fg={color.faint} flexShrink={0}>
        esc
      </text>
    </box>
  );
}

/**
 * Markdown in a scrolling view (a plan), drawn like the conversation:
 * headings, bold, code and lists, not raw `**` and backticks.
 * `plain` for the headless tests (opentui's markdown worker crashes bun test).
 */
function MarkdownBody({ content, scroll, height, width, plain }: { content: string; scroll: number; height: number; width: number; plain?: boolean }) {
  const box = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = scroll;
  }, [scroll]);
  return (
    <scrollbox ref={box} height={height}>
      <Prose text={content} width={Math.max(20, width - 2)} plain={plain} />
    </scrollbox>
  );
}

function Footer({ hints, footer }: { hints?: Hint[]; footer: string }) {
  if (hints?.length) {
    return (
      <text marginTop={1}>
        {hints.map((h, i) => (
          <span key={h.key}>
            {i ? "   " : ""}
            <span fg={color.text}>{h.title}</span> <span fg={color.faint}>{h.key}</span>
          </span>
        ))}
      </text>
    );
  }
  return (
    <text fg={color.faint} marginTop={1}>
      {footer}
    </text>
  );
}

function Body({ view, visible }: { view: DialogView; visible: number }) {
  return (
    <>
      {view.kind === "list" ? <ListBody view={view} visible={visible} /> : null}
      {view.kind === "text" ? <Lines lines={view.lines.slice(view.scroll, view.scroll + visible)} /> : null}
      {view.kind === "text" && view.lines.length > view.scroll + visible ? (
        <text fg={color.faint}>… {view.lines.length - view.scroll - visible} more lines (↓)</text>
      ) : null}
      {view.kind === "input" ? (
        <>
          {view.intro ? <Lines lines={view.intro} /> : null}
          <text fg={color.textDim} marginTop={view.intro ? 1 : 0}>
            {view.label}
          </text>
          <box backgroundColor={color.bg} paddingLeft={1} paddingRight={1}>
            <text>
              <span fg={color.accent}>› </span>
              <span fg={color.white}>{view.mask ? "•".repeat(view.value.length) : view.value}</span>
              <span fg={color.accent}>▏</span>
            </text>
          </box>
        </>
      ) : null}
      {view.notice ? <text fg={toneColor(view.notice.tone)}>{view.notice.text}</text> : null}
    </>
  );
}

/** A dialog centred over the dimmed screen. */
export function DialogOverlay({ view, width, height, plain }: { view: DialogView; width: number; height: number; plain?: boolean }) {
  const doc = view.kind === "text" && view.markdown != null;
  // A document (a plan) gets the room a document needs: wide and nearly full height.
  const panelWidth = Math.min(width - 2, doc ? 116 : "wide" in view && view.wide ? 88 : 72);
  const visible = Math.max(5, Math.floor(height / 2) - 6);
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={100}
      backgroundColor={BACKDROP}
      alignItems="center"
      paddingTop={doc ? 1 : Math.max(1, Math.floor(height / 6))}
    >
      <box width={panelWidth} backgroundColor={color.panel} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <Header title={view.title} asking={view.kind === "list" && view.asking} />
        <box flexDirection="column" marginTop={1}>
          {view.kind === "text" && view.markdown != null ? (
            <MarkdownBody content={view.markdown} scroll={view.scroll} height={Math.max(8, height - 9)} width={panelWidth - 4} plain={plain} />
          ) : (
            <Body view={view} visible={visible} />
          )}
        </box>
        <Footer hints={"hints" in view ? view.hints : undefined} footer={view.footer} />
      </box>
    </box>
  );
}

/** The same dialog inline above the prompt box (the agent's questions). */
export function DialogPanel({ view, height }: { view: DialogView; height: number }) {
  // Leave room for the transcript, the prompt and the status line.
  const visible = Math.max(5, Math.min(16, height - 14));
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={view.kind === "list" && view.asking ? color.accent : color.border}
      backgroundColor={color.panel}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <Header title={view.title} asking={view.kind === "list" && view.asking} />
      <Body view={view} visible={visible} />
      <Footer hints={"hints" in view ? view.hints : undefined} footer={view.footer} />
    </box>
  );
}

function Row({ r, selected }: { r: ListItem; selected: boolean }) {
  const fg = selected ? color.bg : color.text;
  return (
    <box flexDirection="row" backgroundColor={selected ? color.accent : undefined} paddingLeft={1} paddingRight={1}>
      <text fg={selected ? color.bg : toneColor(r.gutter?.tone)} flexShrink={0}>
        {r.gutter ? `${r.gutter.text} ` : "  "}
      </text>
      {/* One line per row: a long description is cut, never wrapped under the next row. */}
      <text flexGrow={1} flexShrink={1} wrapMode="none" overflow="hidden">
        <span fg={fg}>{selected ? <b>{r.label}</b> : r.label}</span>
        {r.badge ? <span fg={selected ? color.bg : toneColor(r.badge.tone)}>{`  ${r.badge.text}`}</span> : null}
        {r.detail ? <span fg={selected ? color.bg : color.muted}>{`  ${r.detail}`}</span> : null}
      </text>
      {r.right ? (
        <text fg={selected ? color.bg : toneColor(r.right.tone)} flexShrink={0}>
          {` ${r.right.text}`}
        </text>
      ) : null}
    </box>
  );
}

function ListBody({ view, visible }: { view: Extract<DialogView, { kind: "list" }>; visible: number }) {
  const items = view.items;
  let seen = -1;
  const selectedRow = items ? items.findIndex((r) => !r.header && ++seen === view.index) : -1;
  const start = items ? Math.max(0, Math.min(selectedRow - Math.floor(visible / 2), items.length - visible)) : 0;
  const shown: ListItem[] = items ? items.slice(start, start + visible) : [];
  return (
    <>
      {view.intro ? <Lines lines={view.intro} /> : null}
      {view.query !== null ? (
        <text marginBottom={1}>
          <span fg={color.accent}>⌕ </span>
          {view.query ? <span fg={color.white}>{view.query}</span> : <span fg={color.faint}>Search</span>}
          <span fg={color.accent}>▏</span>
        </text>
      ) : null}
      {items === null ? <text fg={color.muted}>Loading…</text> : null}
      {items !== null && !items.some((i) => !i.header) ? <text fg={color.muted}>{view.empty}</text> : null}
      {shown.map((r, i) =>
        r.header ? (
          <text key={`h${start + i}`} fg={color.accent} marginTop={i === 0 ? 0 : 1} paddingLeft={1}>
            <b>{r.label}</b>
          </text>
        ) : (
          <Row key={`o${start + i}-${r.id}`} r={r} selected={start + i === selectedRow} />
        ),
      )}
      {items && start + visible < items.length ? <text fg={color.faint}>{`  … ${items.length - start - visible} more`}</text> : null}
      {view.typed ? (
        <box
          border
          borderStyle="rounded"
          borderColor={view.typed.active ? color.accent : color.border}
          paddingLeft={1}
        >
          <text>
            <span fg={color.accent}>{view.typed.active ? "❯ " : "  "}</span>
            {view.typed.value ? (
              <span fg={color.white}>{view.typed.value}</span>
            ) : (
              <span fg={color.faint}>{view.typed.placeholder}</span>
            )}
            {view.typed.active ? <span fg={color.accent}>▏</span> : null}
          </text>
        </box>
      ) : null}
    </>
  );
}
