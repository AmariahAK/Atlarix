/** @jsxImportSource @opentui/react */
/**
 * The conversation — each kind of thing looks different at a glance:
 *
 *   your message      a shaded band, "›", attachments as chips under it
 *   Atlarix's prose   "◆" in the accent, then markdown
 *   thinking          "∴": live, what it's thinking now; done, ONE dim line
 *                     and "thought for 4s" (ctrl+o shows all)
 *   a tool call       "◇" in the status colour, verb + target on one line,
 *                     "╰" and its result under it: a command's first lines,
 *                     an edit's numbered diff (ctrl+o: all of it)
 *   a finished turn   "◆ Build · model · 12s", dim
 *
 * The marks are Atlarix's own (theme.ts `glyph`).
 *
 * Nothing long is shown whole by default: a multi-line command or a long
 * thought is cut to one line, and ctrl+o expands everything. Follows the
 * bottom while new output arrives, until the user scrolls up.
 */
import { useTerminalDimensions } from "@opentui/react";
import { memo } from "react";
import {
  previewLines,
  type Cell,
  type EditDiff,
  type ToolLine,
} from "../agent/transcript";
import { COMMANDS } from "./commands";
import { useDiffSegments } from "./diff-highlight";
import { oneLine } from "./format";
import { Prose } from "./Prose";
import { color, glyph } from "./theme";

const STATUS_ICON: Record<ToolLine["status"], { icon: string; fg: string }> = {
  running: { icon: glyph.tool.running, fg: color.warn },
  success: { icon: glyph.tool.success, fg: color.accentSoft },
  error: { icon: glyph.tool.error, fg: color.error },
  interrupted: { icon: glyph.tool.interrupted, fg: color.muted },
};

/** Paths under the workspace, shown relative to it. */
export function relativeTo(
  workspace: string | undefined,
  text: string,
): string {
  if (!workspace) return text;
  const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return text.split(root).join("");
}

/** Tools whose target is a file: its name stands out, the folder stays dim. */
const FILE_VERBS = new Set(["Read", "Edit", "Read attachment"]);

/** "src/cli/tui/" dim, "App.tsx" bold white, then a ":12-40" range dim. */
function PathTarget({ verb, target }: { verb: string; target: string }) {
  const m = FILE_VERBS.has(verb)
    ? /^(.*\/)?([^/\s:]+)(.*)$/.exec(target)
    : null;
  if (!m) return <span fg={color.textDim}>{target}</span>;
  return (
    <span>
      {m[1] ? <span fg={color.textDim}>{m[1]}</span> : null}
      <span fg={color.white}>
        <b>{m[2]}</b>
      </span>
      {m[3] ? <span fg={color.textDim}>{m[3]}</span> : null}
    </span>
  );
}

/** Lines of an edit shown before ctrl+o (Codex shows a few; the rest is a keypress away). */
const DIFF_LINES = 6;
/** Lines of a command's output shown before ctrl+o. */
const RUN_LINES = 5;

/** A line's number in the file: its block's start there, plus its place in the block. */
function lineNo(diff: EditDiff, l: EditDiff["lines"][number]): string {
  if (l.no == null) return "";
  const start = l.block != null ? diff.starts?.[l.block] : null;
  return String(start != null ? start - 1 + l.no : l.no);
}

function DiffView({
  diff,
  expanded,
  width,
  path,
}: {
  diff: EditDiff;
  expanded: boolean;
  width: number;
  /** The edited file: its language colours the lines (grammars.ts). */
  path?: string;
}) {
  const lines = expanded
    ? diff.lines.slice(0, 160)
    : diff.lines.slice(0, DIFF_LINES);
  const more = diff.lines.length - lines.length;
  const numWidth = Math.max(3, ...lines.map((l) => lineNo(diff, l).length));
  const shown = lines.map((l) => (l.kind === "gap" ? "" : oneLine(l.text.replace(/\t/g, "    "), width - numWidth - 8)));
  const segs = useDiffSegments(path, shown);
  return (
    <box flexDirection="column" paddingLeft={2}>
      {lines.map((l, i) =>
        l.kind === "gap" ? (
          <text key={i} fg={color.faint}>
            {`${" ".repeat(numWidth)}  ⋯`}
          </text>
        ) : (
          <text
            key={i}
            bg={
              l.kind === "add"
                ? color.addBg
                : l.kind === "remove"
                  ? color.removeBg
                  : undefined
            }
          >
            <span fg={color.faint}>{lineNo(diff, l).padStart(numWidth)} </span>
            <span
              fg={
                l.kind === "add"
                  ? color.accentSoft
                  : l.kind === "remove"
                    ? color.error
                    : color.faint
              }
            >
              {l.kind === "add" ? "+" : l.kind === "remove" ? "−" : " "}
            </span>
            <span fg={l.kind === "context" ? color.muted : color.text}>{" "}</span>
            {segs?.[i]?.length ? (
              segs[i]!.map((g, k) => (
                <span key={k} fg={g.fg ?? (l.kind === "context" ? color.muted : color.text)}>
                  {g.italic ? <i>{g.text}</i> : g.text}
                </span>
              ))
            ) : (
              <span fg={l.kind === "context" ? color.muted : color.text}>{shown[i] || " "}</span>
            )}
          </text>
        ),
      )}
      {more > 0 ? (
        <text
          fg={color.faint}
        >{`  … ${more} more line${more === 1 ? "" : "s"} (ctrl+o)`}</text>
      ) : null}
    </box>
  );
}

function ToolCell({
  tool,
  expanded,
  width,
  workspace,
}: {
  tool: ToolLine;
  expanded: boolean;
  width: number;
  workspace?: string;
}) {
  const s = STATUS_ICON[tool.status];
  const room = Math.max(20, width - tool.verb.length - 6);
  const fullTarget = relativeTo(workspace, tool.target);
  const target = expanded ? fullTarget : oneLine(fullTarget, room);
  const preview = previewLines(tool.output, 40);
  // A failed command: ONE line (its error, and the exit code), like a thought;
  // ctrl+o shows the whole output.
  const failed = tool.status === "error";
  const runLines = previewLines(tool.output, failed ? 1 : RUN_LINES);
  const exit = tool.summary?.includes("exit ")
    ? tool.summary.split(" · ").pop()
    : undefined;
  const showRun =
    !tool.diff &&
    !expanded &&
    tool.verb === "Run" &&
    runLines.lines.some((l) => l.trim());
  return (
    <box flexDirection="column">
      {tool.verb === "!" ? (
        // A command you ran yourself: a band like your messages, "!" in place of "›".
        <box
          backgroundColor={color.promptBg}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="row"
        >
          <text fg={color.warn} flexShrink={0}>
            <b>{"! "}</b>
          </text>
          <text fg={color.white} flexGrow={1}>
            {expanded ? tool.target : oneLine(tool.target, room)}
          </text>
        </box>
      ) : (
        <text>
          <span fg={s.fg}>{s.icon}</span>{" "}
          <span fg={color.white}>{tool.verb}</span>{" "}
          <PathTarget verb={tool.verb} target={target} />
          {tool.diff?.added ? (
            <span fg={color.accentSoft}>{`  +${tool.diff.added}`}</span>
          ) : null}
          {tool.diff?.removed ? (
            <span
              fg={color.error}
            >{`${tool.diff.added ? " " : "  "}−${tool.diff.removed}`}</span>
          ) : null}
          {tool.status === "interrupted" ? (
            <span fg={color.faint}> · interrupted</span>
          ) : null}
        </text>
      )}
      {tool.children?.length ? (
        <box flexDirection="column" paddingLeft={2}>
          {(expanded ? tool.children : tool.children.slice(-5)).map((c, i) => {
            const cs = STATUS_ICON[c.status];
            return (
              <text key={c.id + i}>
                <span fg={color.faint}>{`${glyph.child} `}</span>
                <span fg={cs.fg}>{cs.icon}</span>{" "}
                <span fg={color.textDim}>{c.verb}</span>{" "}
                <span fg={color.muted}>
                  {oneLine(c.target, Math.max(20, width - 16))}
                </span>
              </text>
            );
          })}
          {!expanded && tool.children.length > 5 ? (
            <text
              fg={color.faint}
            >{`  … ${tool.children.length - 5} earlier (ctrl+o)`}</text>
          ) : null}
        </box>
      ) : null}
      {tool.progress ? (
        <text fg={color.muted}>
          {`  ${glyph.result} `}
          <i>{oneLine(tool.progress, width - 8)}</i>
        </text>
      ) : null}
      {tool.diff ? (
        <DiffView diff={tool.diff} expanded={expanded} width={width} path={tool.target} />
      ) : null}
      {/* A command shows the start of its output, not just its first line. */}
      {showRun ? (
        <box flexDirection="column">
          {failed ? (
            <text fg={color.error}>
              {`  ${glyph.result} ${oneLine(runLines.lines.find((l) => l.trim()) ?? "", width - 12 - (exit?.length ?? 0))}`}
              {exit ? <span fg={color.faint}>{` · ${exit}`}</span> : null}
            </text>
          ) : (
            <>
              {runLines.lines.map((line, i) => (
                <text key={i} fg={color.muted}>
                  {`  ${i === 0 ? glyph.result : " "} ${oneLine(line, width - 8) || " "}`}
                </text>
              ))}
              {runLines.more > 0 ? (
                <text
                  fg={color.faint}
                >{`    … ${runLines.more} more lines (ctrl+o)`}</text>
              ) : null}
              {exit ? <text fg={color.error}>{`    ${exit}`}</text> : null}
            </>
          )}
        </box>
      ) : null}
      {!tool.diff && !expanded && tool.summary && !showRun ? (
        <text fg={tool.status === "error" ? color.error : color.muted}>
          {`  ${glyph.result} `}
          {oneLine(relativeTo(workspace, tool.summary), width - 8)}
        </text>
      ) : null}
      {!tool.diff && expanded && preview.lines.some((l) => l.trim()) ? (
        <box
          flexDirection="column"
          paddingLeft={2}
          marginLeft={1}
          border={["left"]}
          borderColor={color.border}
        >
          {preview.lines.map((line, i) => (
            <text
              key={i}
              fg={tool.status === "error" ? color.error : color.muted}
            >
              {line || " "}
            </text>
          ))}
          {preview.more > 0 ? (
            <text fg={color.faint}>… {preview.more} more lines</text>
          ) : null}
        </box>
      ) : null}
    </box>
  );
}

/** Your message, with a /command it starts with in the accent. */
function CommandText({ text }: { text: string }) {
  const word = /^\/[\w-]+/.exec(text)?.[0];
  if (!word || !COMMANDS.some((c) => c.name === word)) {
    return (
      <text fg={color.white} flexGrow={1}>
        {text}
      </text>
    );
  }
  return (
    <text fg={color.white} flexGrow={1}>
      <span fg={color.accentSoft}>
        <b>{word}</b>
      </span>
      {text.slice(word.length)}
    </text>
  );
}

/** Lines of a sent paste shown before ctrl+o. */
const PASTE_LINES = 8;

/** A sent message with a paste shows the pasted text, cut to a few lines until ctrl+o. */
function pasteView(
  cell: Extract<Cell, { kind: "user" }>,
  expanded: boolean,
): { text: string; more: number } {
  if (!cell.full) return { text: cell.text, more: 0 };
  const lines = cell.full.split("\n");
  if (expanded || lines.length <= PASTE_LINES)
    return { text: cell.full, more: 0 };
  return {
    text: lines.slice(0, PASTE_LINES).join("\n"),
    more: lines.length - PASTE_LINES,
  };
}

/** Two tool lines that draw the same. */
function sameTool(a: ToolLine, b: ToolLine): boolean {
  return (
    a === b ||
    (a.status === b.status &&
      a.verb === b.verb &&
      a.target === b.target &&
      a.summary === b.summary &&
      a.output?.length === b.output?.length &&
      a.progress === b.progress &&
      (a.children?.length ?? 0) === (b.children?.length ?? 0) &&
      (a.children ?? []).every(
        (c, i) =>
          c.status === b.children![i]!.status &&
          c.summary === b.children![i]!.summary,
      ) &&
      a.diff?.added === b.diff?.added &&
      a.diff?.removed === b.diff?.removed &&
      (a.diff?.starts ?? []).join() === (b.diff?.starts ?? []).join())
  );
}

/** Two cells that draw the same (cells are rebuilt on every chunk; most haven't changed). */
function sameCell(a: Cell, b: Cell): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  switch (a.kind) {
    case "tool":
      return sameTool(a.tool, (b as typeof a).tool);
    case "thought":
      return a.text === (b as typeof a).text && a.ms === (b as typeof a).ms;
    case "user":
      return (
        a.text === (b as typeof a).text &&
        a.full === (b as typeof a).full &&
        (a.chips ?? []).join() === ((b as typeof a).chips ?? []).join()
      );
    case "answers":
      return JSON.stringify(a.pairs) === JSON.stringify((b as typeof a).pairs);
    case "footer":
      return (
        a.text === (b as typeof a).text &&
        a.interrupted === (b as typeof a).interrupted
      );
    default:
      return (a as { text: string }).text === (b as { text: string }).text;
  }
}

/**
 * A cell redraws only when what it shows changed. Without this, every chunk of
 * a streaming reply redrew every cell of the session; on a long one (a 1,400-
 * line output re-split each time) the screen fell behind the keyboard.
 */
const CellView = memo(
  CellViewInner,
  (p, n) =>
    p.expanded === n.expanded &&
    p.plain === n.plain &&
    p.live === n.live &&
    p.width === n.width &&
    p.workspace === n.workspace &&
    p.prev?.kind === n.prev?.kind &&
    sameCell(p.cell, n.cell),
);

function CellViewInner({
  cell,
  expanded,
  plain,
  prev,
  live,
  width,
  workspace,
}: {
  workspace?: string;
  cell: Cell;
  expanded: boolean;
  plain: boolean;
  prev?: Cell;
  /** The answer still being written: markdown re-parses it as it grows. */
  live: boolean;
  width: number;
}) {
  // A blank line between blocks, none between consecutive tool calls.
  const spaced =
    prev != null && !(cell.kind === "tool" && prev.kind === "tool");
  switch (cell.kind) {
    case "user":
      // A band with a blank row above and below it (Codex): your messages are
      // where the conversation turns, so they stand out. Wrapped lines stay
      // under the text, not under the mark.
      return (
        <box
          marginTop={1}
          flexDirection="column"
          backgroundColor={color.promptBg}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <box flexDirection="row">
            <text fg={color.accent} flexShrink={0}>
              {`${glyph.prompt} `}
            </text>
            <CommandText text={pasteView(cell, expanded).text} />
          </box>
          {pasteView(cell, expanded).more > 0 ? (
            <text
              fg={color.faint}
            >{`  … ${pasteView(cell, expanded).more} more lines (ctrl+o)`}</text>
          ) : null}
          {cell.chips?.length ? (
            <text>
              <span fg={color.faint}>{`  ${glyph.result} `}</span>
              {cell.chips.map((chip, i) => (
                <span key={i}>
                  {i ? " " : ""}
                  <span
                    fg={color.accent}
                    bg={color.accentBg}
                  >{` ${chip.replace(/^\[|\]$/g, "")} `}</span>
                </span>
              ))}
            </text>
          ) : null}
        </box>
      );
    case "answers":
      return (
        <box
          marginTop={1}
          flexDirection="column"
          backgroundColor={color.promptBg}
          paddingLeft={1}
          paddingRight={1}
        >
          {cell.pairs.map((p, i) => (
            <box key={i} flexDirection="column">
              <text>
                <span fg={color.warn}>{`${glyph.question} `}</span>
                <span fg={color.textDim}>{p.question}</span>
              </text>
              <text>
                <span fg={color.accent}>{`${glyph.prompt} `}</span>
                <span fg={color.white}>
                  <b>{p.answer}</b>
                </span>
              </text>
            </box>
          ))}
        </box>
      );
    case "thought": {
      // Still being written: what it is thinking now. Done: its title (a bold
      // first line) or first line, and how long it took. ctrl+o: all of it.
      const lines = cell.text.split("\n").filter((l) => l.trim());
      const title = /^\*\*(.+?)\*\*$/.exec(lines[0]?.trim() ?? "")?.[1];
      const took =
        cell.ms != null && cell.ms >= 1000
          ? ` · thought for ${Math.round(cell.ms / 1000)}s`
          : "";
      const head = live
        ? `Thinking… ${(lines.at(-1) ?? "").replace(/\*\*/g, "")}`
        : (title ?? (lines[0] ?? "").replace(/\*\*/g, ""));
      return (
        <box marginTop={spaced ? 1 : 0} flexDirection="row">
          <text fg={live ? color.warn : color.faint} flexShrink={0}>
            {`${glyph.thought} `}
          </text>
          {expanded ? (
            <text fg={color.muted} flexGrow={1}>
              <i>{cell.text}</i>
              <span fg={color.faint}>{took}</span>
            </text>
          ) : (
            <text fg={color.muted} flexGrow={1}>
              <i>
                {oneLine(
                  `${head}${lines.length > 1 && !live ? "\n…" : ""}`,
                  width - 8 - took.length,
                )}
              </i>
              <span fg={color.faint}>{took}</span>
            </text>
          )}
        </box>
      );
    }
    case "footer":
      return (
        <text fg={color.faint} marginTop={1}>
          {`${glyph.reply} ${cell.text}${cell.interrupted ? " · interrupted" : ""}`}
        </text>
      );
    case "markdown":
      return (
        <box marginTop={spaced ? 1 : 0} flexDirection="row">
          <text fg={color.accent} flexShrink={0}>
            {`${glyph.reply} `}
          </text>
          <box flexGrow={1}>
            {/* Two columns for the mark, one for the transcript's scrollbar. */}
            <Prose text={cell.text} streaming={live} width={Math.max(20, width - 3)} plain={plain} />
          </box>
        </box>
      );
    case "tool":
      return (
        <box marginTop={spaced ? 1 : 0}>
          <ToolCell
            tool={cell.tool}
            expanded={expanded}
            width={width}
            workspace={workspace}
          />
        </box>
      );
    case "notice":
      return (
        <text
          fg={cell.level === "error" ? color.error : color.muted}
          marginTop={spaced ? 1 : 0}
        >
          {cell.text}
        </text>
      );
  }
}

/**
 * `plain` draws prose as plain text instead of <markdown>. For the headless UI
 * tests: opentui's markdown parses in a worker that crashes `bun test` (it runs
 * fine in the compiled binary and from source; scripts/probes/markdown-probe.tsx).
 */
export function Transcript({
  cells,
  expanded,
  plain = false,
  busy = false,
  workspace,
}: {
  /** Paths under it are shown relative. */
  workspace?: string;
  cells: Cell[];
  expanded: boolean;
  plain?: boolean;
  busy?: boolean;
}) {
  const { width } = useTerminalDimensions();
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
      {/* paddingRight: the scrollbar is drawn OVER the last column, so text that
          wrapped exactly to the edge lost its last character under it — the
          "cut off" ends of lines (owner, 2026-10-04: "…the Atlarix agent" with
          its "." gone, a closing ")" missing). */}
      <box flexDirection="column" gap={0} paddingRight={2}>
        {cells.map((c, i) => (
          <CellView
            key={c.id}
            cell={c}
            expanded={expanded}
            plain={plain}
            prev={cells[i - 1]}
            live={busy && i === cells.length - 1}
            width={Math.max(30, width - 4)}
            workspace={workspace}
          />
        ))}
      </box>
    </scrollbox>
  );
}
