/** @jsxImportSource @opentui/react */
/**
 * The whole screen: transcript, what is pending, the working line, the prompt
 * box, the status line. Keys follow Codex and Claude Code:
 *
 *   enter          send; while a turn runs, steer it (read at its next step)
 *   tab            while a turn runs, queue for after it
 *   alt+↑          pull the last queued message back into the box
 *   esc            stop the turn · close a menu · answer "no"
 *   shift+tab      cycle build → ask → plan
 *   ctrl+o         expand / collapse tool output
 *   ctrl+c         clear the box; twice on an empty box quits
 *   /              commands
 *   @              a file or folder from this workspace
 *   !command       run it yourself; the agent sees it with your next message
 *   select text    with the mouse: copied when you let go (clipboard.ts)
 *
 * Every command screen (/resume, /automations, /status, the plan and question
 * prompts …) is a dialog on one stack (dialogs.ts, screens.ts): while one is
 * open it owns the keyboard, and esc closes it.
 */
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { splitPeerMessages } from "@/lib/peers/peer-message";
import { TAB_FRAME_MS, tabTitle, titleSequence } from "./tab-title";

/**
 * Escape sequences the renderer does not draw itself (the tab title, the
 * desktop notification) go out through ITS writer. Written to process.stdout
 * they landed between the renderer thread's writes, inside a colour code:
 * `\x1b[38;2;196;181` + the title + `;253m`, and every terminal then printed
 * `;253m` over the transcript (found recording the launch video, 2026-10-05).
 */
export function termWrite(renderer: unknown, data: string): void {
  const out = (renderer as { writeOut?: (chunk: string) => unknown } | null)?.writeOut;
  if (typeof out === "function") out.call(renderer, data);
  else process.stdout.write(data);
}
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSession, LiveTask, SessionState, WorkMode } from "../agent/session";
import { Approval, approvalChoices, approvalKey } from "./Approval";
import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import { AUTO_CONSENT_MARKER } from "@/shared/billing_copy";
import { COMMANDS, matchCommands, parseCommandLine } from "./commands";
import { DialogHost, InputDialog, ListDialog, type Line, type ListItem } from "./dialogs";
import { pickTip, type Tip } from "./tips";
import { DialogOverlay, DialogPanel } from "./Dialog";
import { Toast, type ToastState, type ToastVariant } from "./Toast";
import type { UpdateEvent } from "../update";
import { realServices, type CliServices } from "../agent/services";
import {
  openTaskDetails,
  openTasks,
  openAside,
  openRename,
  openAutoConsent,
  openAutomations,
  openAnalytics,
  openBilling,
  openChrome,
  openConnect,
  openLogin,
  openLogout,
  openMcp,
  openMcpConsent,
  openPermissions,
  openPlan,
  openRelics,
  openQuestions,
  openResume,
  openRewind,
  openStatus,
  type PendingEdit,
  runCompact,
  runExport,
  runImport,
  type ScreenContext,
} from "./screens";
import { Composer, type ComposerApi } from "./Composer";
import {
  groupOptions,
  rememberChoice,
  toggleFavorite,
  type CliState,
  type ModelOption,
  type ModelRef,
} from "../agent/models";
import { filterEntries, listWorkspaceEntries, mentionAt, mentionInsert } from "../agent/file-index";
import { parseShellInput } from "../agent/shell-mode";
import { abbreviatePath, activityLabel, formatTokens, oneLine } from "./format";
import { copyText } from "./clipboard";
import { color, glyph } from "./theme";
import { errorNotice, type ErrorNotice } from "./limits";
import { SessionHeader, type AccountKind } from "./Header";
import { RATING_CHANCE, RATINGS, shouldAskRating } from "./session-rating";
import { PlanPanel, type PinnedPlan, type PlanScroll } from "./PlanPanel";
import { Transcript } from "./Transcript";
import { recapDecision, type RecapClock } from "@/lib/recap/rules";

/** shift+tab order. The same five modes as the app, named the way the app names them. */
const MODES: WorkMode[] = ["build", "ask", "plan", "debug", "review"];
export const MODE_LABEL: Record<WorkMode, string> = {
  build: "Build",
  ask: "Explore",
  plan: "Plan",
  debug: "Debug",
  review: "Review",
};
const MODE_HINT: Record<WorkMode, string> = {
  build: "make the changes",
  ask: "read, search and run; no edits",
  plan: "write a plan to agree on first",
  debug: "find the cause, then fix it",
  review: "review changes and point out problems",
};

export interface AppProps {
  session: AgentSession;
  modelLabel: string;
  version: string;
  onQuit: () => void;
  /** Prose as plain text rather than markdown (see Transcript). Tests only. */
  plainMarkdown?: boolean;
  /** `/model` and ctrl+t. Absent: the picker is not offered (the dev endpoint has one model). */
  models?: ModelSource;
  /** Where a mouse selection goes. Default: the clipboard. Tests pass a recorder. */
  copy?: (text: string) => Promise<boolean>;
  /** Automations, MCP, permissions, keys, the account. Tests pass a fake. */
  services?: CliServices;
  /** What /status says about Chrome. */
  chromeStatus?: () => string;
  /** /login: browser sign-in (or a code over SSH), showing its progress. */
  signIn?: (show: (lines: Line[]) => void) => Promise<string>;
  /** A command to run as the screen opens (`atlarix --resume`). */
  startWith?: string;
  /** Starts the background self-update (src/cli/update.ts). */
  autoUpdate?: (notify: (e: UpdateEvent) => void) => void;
  /** Opens a link in the browser. Tests pass a recorder: a test must never open the user's browser. */
  openUrl?: (url: string) => void;
  /** How likely this session is to ask for a rating (session-rating.ts); tests pass 1. */
  ratingChance?: number;
}

export interface ModelSource {
  load: () => Promise<ModelOption[]>;
  state: () => CliState;
  save: (s: CliState) => void;
  /** Use this model from the next message on. */
  choose: (ref: ModelRef) => void;
  setDeepThinking: (on: boolean) => void;
}

function elapsed(since: number | null, now: number): string {
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The working line after the spinner: "Thinking… 1m 08s · ↓ 4.5k tokens ·
 * thought for 4s": how long, how much it has written, how long it last thought.
 */
export function workingLine(o: { activity: string; since: number | null; now: number; tokens: number | null; cells: SessionState["cells"] }): string {
  let thought: number | undefined;
  for (let i = o.cells.length - 1; i >= 0; i--) {
    const c = o.cells[i]!;
    if (c.kind === "user" || c.kind === "answers") break;
    if (c.kind === "thought" && c.ms != null) {
      thought = c.ms;
      break;
    }
  }
  return [
    `${o.activity} ${elapsed(o.since, o.now)}`.trim(),
    o.tokens ? `↓ ${formatTokens(o.tokens)} tokens` : null,
    thought != null && thought >= 1000 ? `thought for ${Math.round(thought / 1000)}s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The newest relic in the transcript: "Published <url>" or "Saved <path>". */
export function lastRelic(cells: SessionState["cells"]): string | null {
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!;
    if (c.kind !== "tool" || c.tool.verb !== "Relic") continue;
    const m = /^(?:Published|Saved) (\S.*)$/.exec(c.tool.output ?? c.tool.summary ?? "");
    if (m) return m[1]!;
  }
  return null;
}

/** A failed turn: what happened, and the way out (limits.ts). */
function ErrorBlock({ notice }: { notice: ErrorNotice }) {
  const fg = notice.tone === "warn" ? color.warn : color.error;
  return (
    <box flexDirection="column" flexShrink={0} border={["left"]} borderColor={fg} paddingLeft={1} marginTop={1}>
      <text fg={fg}>
        <b>{`⚠ ${notice.title}`}</b>
      </text>
      {notice.detail ? <text fg={color.muted}>{notice.detail}</text> : null}
      {notice.actions ? (
        <text>
          {notice.actions.split(" · ").map((a, i) => {
            const [key, ...what] = a.split(" ");
            return (
              <span key={i}>
                {i ? <span fg={color.faint}>{"  ·  "}</span> : null}
                <span fg={color.accentSoft}>{key}</span>
                <span fg={color.muted}>{` ${what.join(" ")}`}</span>
              </span>
            );
          })}
        </text>
      ) : null}
    </box>
  );
}

/** "1m 05s" / "42s". */
function age(ms: number): string {
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
}

/** A row under the prompt box: one per sub-agent; every background command shares one. */
export type StripRow = { kind: "agent"; task: LiveTask } | { kind: "commands"; tasks: LiveTask[] };

export function stripRows(tasks: LiveTask[]): StripRow[] {
  const rows: StripRow[] = tasks.filter((t) => t.kind === "agent").map((task) => ({ kind: "agent", task }));
  const commands = tasks.filter((t) => t.kind === "command");
  if (commands.length) rows.push({ kind: "commands", tasks: commands });
  return rows;
}

/** Agent rows shown before the rest fold into "… N more". */
const AGENT_ROWS = 6;

/**
 * What is running, UNDER the prompt box (Claude Code's agent list; owner,
 * 2026-10-05: "raise the text box above the ground"): "main" and what it is
 * doing, then each sub-agent on its own row with what it is doing now, how
 * long it has run and its tokens; finished ones drop off. Background commands
 * share one row. ↓ from the box picks a row, enter opens it.
 */
function AgentRows({ rows, width, selected, main }: { rows: StripRow[]; width: number; selected: number | null; main: string | null }) {
  const start = selected != null && selected >= AGENT_ROWS ? selected - AGENT_ROWS + 1 : 0;
  const shown = rows.slice(start, start + AGENT_ROWS);
  const hidden = rows.length - shown.length;
  const line = (key: string, picked: boolean, mark: string, markColor: string, name: string, doing: string, right: string) => (
    <box key={key} flexDirection="row" backgroundColor={picked ? color.promptBg : undefined}>
      <text flexShrink={1}>
        <span fg={markColor}>{`${mark} `}</span>
        <span fg={picked ? color.white : color.text}>{name}</span>
        {doing ? <span fg={color.muted}>{`  ${oneLine(doing, Math.max(16, width - name.length - right.length - 10))}`}</span> : null}
      </text>
      <box flexGrow={1} />
      <text fg={color.faint} flexShrink={0}>{right}</text>
    </box>
  );
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {line("main", false, "●", color.accent, "main", main ?? "idle", "")}
      {shown.map((r, i) => {
        const picked = selected === start + i;
        if (r.kind === "commands") {
          const n = r.tasks.length;
          const longest = Math.max(...r.tasks.map((t) => t.elapsedMs));
          return line(
            "commands",
            picked,
            glyph.tool.running,
            color.warn,
            `${n} command${n === 1 ? "" : "s"}`,
            r.tasks.map((t) => t.label.split("\n")[0]).join(", "),
            age(longest),
          );
        }
        const t = r.task;
        const last = t.tools.at(-1);
        const doing = last ? `${last.verb} ${last.target.split("\n")[0]}` : (t.progress ?? "starting");
        const right = [`${t.stalled ? "quiet " : ""}${age(t.elapsedMs)}`, t.tokens ? `↓ ${formatTokens(t.tokens)} tokens` : null].filter(Boolean).join(" · ");
        return line(t.id, picked, "○", picked ? color.accent : color.textDim, oneLine(t.label.split("\n")[0] ?? "Sub-agent", 28), doing, right);
      })}
      <text fg={color.faint}>
        {hidden > 0 ? `  … ${hidden} more · ` : "  "}
        {selected != null ? "enter open · x stop · esc back" : "↓ to select"}
      </text>
    </box>
  );
}

/** A tip: "tip" and the keys in the accent, then what they do. */
function TipLine({ tip }: { tip: Tip }) {
  return (
    <text>
      <span fg={color.faint}>{"  tip "}</span>
      {tip.keys ? <span fg={color.accentSoft}>{tip.keys} </span> : null}
      <span fg={color.muted}>{tip.text}</span>
    </text>
  );
}

/** Commands that change the conversation: typed mid-turn, they wait for it to end. */
const AFTER_TURN = new Set(["/compact", "/new", "/resume", "/undo", "/import"]);

/** "context 23% · 47k/205k", or null before the first step reports. */
export function contextLabel(s: Pick<SessionState, "contextPercent" | "contextUsed" | "contextLimit">): string | null {
  if (s.contextPercent == null) return null;
  const of = s.contextUsed != null && s.contextLimit ? ` · ${formatTokens(s.contextUsed)}/${formatTokens(s.contextLimit)}` : "";
  return `context ${s.contextPercent}%${of}`;
}

/** "2 agents · 1 command" running in the background, or null. */
export function runningLabel(r: { agents: number; commands: number }): string | null {
  const parts = [
    r.agents ? `${r.agents} agent${r.agents === 1 ? "" : "s"}` : null,
    r.commands ? `${r.commands} command${r.commands === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The keys that do something right now, for the box's bottom border: while a
 * turn runs, how to stop, steer, queue or look at what's running; otherwise
 * where you are and how to get around.
 */
export function borderHints(o: {
  busy: boolean;
  queued: boolean;
  running: boolean;
  narrow: boolean;
  place: string;
  /** MCP servers switched on in this folder. */
  mcp?: number;
  /** The session's name, once it has one. */
  title?: string | null;
  /** Columns the border has for it: the least useful hints go first, a long name ends in "…". */
  max?: number;
}): string {
  const tasks = o.running ? "↓ tasks" : null;
  const fit = (parts: Array<string | null>, dropOrder: string[]) => {
    let kept = parts.filter((p): p is string => !!p);
    const len = () => kept.join(" · ").length;
    for (const d of dropOrder) {
      if (o.max == null || len() <= o.max) break;
      kept = kept.filter((p) => p !== d);
    }
    return kept.join(" · ");
  };
  if (o.busy) {
    const queued = o.queued ? "alt+↑ edit queued" : null;
    return fit(["esc stop", "enter steer", "tab queue", queued, tasks], ["tab queue", "enter steer"]);
  }
  const title = o.title ? oneLine(o.title, o.max != null && o.max < 90 ? 20 : 32) : null;
  if (o.narrow) return [title ?? o.place, tasks].filter(Boolean).join(" · ");
  const mcp = o.mcp ? `⊙ ${o.mcp} MCP` : null;
  // ctrl+o isn't here: each collapsed item says "(ctrl+o)" where it has more.
  return fit([title, o.place, mcp, "/commands", "shift+tab mode", tasks], [mcp ?? "", "shift+tab mode", "/commands", o.place]);
}

/** The palette's visible rows: at most 8, kept around the highlighted one. */
function paletteWindow(n: number, selected: number, visible = 8): number[] {
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), n - visible));
  return Array.from({ length: Math.min(n, visible) }, (_, k) => start + k);
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The spinner line. It owns its ticking: when the 10-per-second tick lived in
 * App, every tick re-rendered the WHOLE screen, transcript included, and a long
 * session fell behind the keyboard (half-read mouse sequences like "<65;17"
 * landed in the prompt box). Now a tick redraws this one line.
 */
function WorkingLine(props: { activity: string; since: number | null; tokens: number | null; cells: SessionState["cells"] }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);
  return (
    <text>
      <span fg={color.accent}>{SPINNER[tick % SPINNER.length]}</span>
      <span fg={color.muted}>{` ${workingLine({ ...props, now: Date.now() })}`}</span>
    </text>
  );
}

export function App({
  session,
  modelLabel: initialModelLabel,
  version,
  onQuit,
  plainMarkdown = false,
  models,
  copy,
  services,
  chromeStatus,
  signIn,
  startWith,
  autoUpdate,
  openUrl,
  ratingChance = RATING_CHANCE,
}: AppProps) {
  const [state, setState] = useState<SessionState>(session.state);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [quitArmed, setQuitArmed] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [modelLabel, setModelLabel] = useState(initialModelLabel);
  const [accountKind, setAccountKind] = useState<AccountKind | null>(null);
  // `@` completion: the query after the @, the matches, the highlighted one.
  // Through a ref: keys can arrive faster than React renders (fast typing, a
  // paste), and none may be built on a stale query.
  const [mention, setMentionState] = useState<{ query: string; matches: string[]; index: number } | null>(null);
  const mentionRef = useRef<typeof mention>(null);
  const setMention = (next: typeof mention) => {
    mentionRef.current = next;
    setMentionState(next);
  };
  const mentionSeq = useRef(0);
  const updateMention = () => {
    const query = mentionAt(composer.current?.beforeCursor() ?? "");
    if (query == null) {
      if (mentionRef.current) setMention(null);
      return;
    }
    const seq = ++mentionSeq.current;
    void listWorkspaceEntries(session.workspaceDir).then((entries) => {
      if (seq !== mentionSeq.current) return;
      const matches = filterEntries(entries, query);
      setMention(matches.length ? { query, matches, index: 0 } : null);
    });
  };
  const chooseMention = (entry: string) => {
    const m = mentionRef.current;
    if (!m) return;
    setMention(null);
    composer.current?.replaceBeforeCursor(m.query.length + 1, mentionInsert(entry));
  };
  const [cliState, setCliState] = useState<CliState>(() => models?.state() ?? { recent: [], favorites: [] });
  const [deep, setDeep] = useState<boolean>(() => models?.state().deepThinking ?? false);
  const composer = useRef<ComposerApi | null>(null);
  const renderer = useRenderer();
  // /undo and esc esc: the earlier message the next send replaces.
  const [edit, setEditState] = useState<PendingEdit | null>(null);
  const editRef = useRef<PendingEdit | null>(null);
  const setEdit = (e: PendingEdit | null) => {
    editRef.current = e;
    setEditState(e);
  };
  const lastEscAt = useRef(0);
  const host = useRef(new DialogHost()).current;
  const [, setDialogVersion] = useState(0);
  // Which prompt the session raised by itself is on the stack, so closing it
  // with esc can tell the session (a question left unanswered, a plan for later).
  const autoPrompt = useRef<null | "question" | "consent" | "mcp">(null);
  useEffect(() => {
    const on = () => {
      setDialogVersion((n) => n + 1);
      if (!host.open && autoPrompt.current) {
        const which = autoPrompt.current;
        autoPrompt.current = null;
        if (which === "question" && session.state.question) session.dismissQuestion();
        // Closed without choosing: the tool call is refused, as the app's toast does on dismiss.
        if (which === "mcp" && session.state.mcpConsent) void session.answerMcpConsent("decline");
      }
    };
    host.on("change", on);
    return () => void host.off("change", on);
  }, [host, session]);
  // A key typed into a dialog's field can be a whole paste.
  useEffect(() => {
    const onPaste = (e: PasteEvent) => {
      const top = host.top;
      if (!(top instanceof InputDialog)) return;
      e.preventDefault();
      top.paste(decodePasteBytes(e.bytes));
    };
    renderer.keyInput.on("paste", onPaste);
    return () => void renderer.keyInput.off("paste", onPaste);
  }, [renderer, host]);
  /**
   * The prompt box gets the keyboard back (opencode's refocus): after a click
   * anywhere, and when the terminal window or tab is focused again. A click
   * moves opentui's focus to whatever was clicked, and the `focused` prop never
   * changes, so without this, typing after switching tabs and clicking back
   * went nowhere until something else re-rendered the box.
   */
  const refocusPrompt = () => {
    if (host.open || session.state.approvals.length) return;
    setTimeout(() => composer.current?.focus(), 0);
  };
  useEffect(() => {
    renderer.on("focus", refocusPrompt);
    return () => void renderer.off("focus", refocusPrompt);
  }, [renderer]);

  // Copy on select: the renderer reports a selection when the mouse is released.
  useEffect(() => {
    const onSelection = (sel: { getSelectedText(): string } | null) => {
      const text = sel?.getSelectedText() ?? "";
      refocusPrompt();
      if (!text.trim()) return;
      void (copy ? copy(text) : copyText(text, renderer)).then((ok) => {
        if (ok) flash(`Copied ${text.length} character${text.length === 1 ? "" : "s"}`, 2000, "success");
      });
    };
    renderer.on("selection", onSelection);
    return () => void renderer.off("selection", onSelection);
  }, [renderer, copy]);
  const { width, height } = useTerminalDimensions();
  // Sent prompts, oldest first, for ↑/↓ (like every shell and the other CLIs).
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const remember = (text: string) => {
    const t = text.trim();
    if (t && history.current.at(-1) !== t) history.current.push(t);
    historyIndex.current = null;
  };

  useEffect(() => {
    const on = (s: SessionState) => setState(s);
    session.on("change", on);
    // An automation finished (here or in the app): one line, then /automations has the rest.
    const onAutomation = (run: { automationName?: string; summary?: string | null; error?: string | null; status?: string }) => {
      const what = (run.error ?? run.summary ?? (run.status === "nothing-to-report" ? "nothing to report" : "done")).split("\n")[0];
      flash(`● Automation “${run.automationName ?? "automation"}” · ${what}  (/automations)`, 10_000);
    };
    session.on("automation", onAutomation);
    return () => {
      session.off("change", on);
      session.off("automation", onAutomation);
    };
  }, [session]);

  // What's running in the background, for the border's count and ↓. Polled:
  // background commands and sub-agents outlive the turn that started them.
  const [running, setRunning] = useState({ agents: 0, commands: 0 });
  // The running tasks themselves, for the strip above the prompt box.
  const [liveTasks, setLiveTasks] = useState<LiveTask[]>([]);
  // The strip row picked with ↓ (null: the prompt box has the keys).
  const [stripSel, setStripSel] = useState<number | null>(null);
  const rows = useMemo(() => stripRows(liveTasks), [liveTasks]);
  const stripRef = useRef<{ sel: number | null; rows: StripRow[] }>({ sel: null, rows: [] });
  stripRef.current.rows = rows;
  // Set at once, not on the next render: two quick ↓ must move two rows.
  const pickStrip = (n: number | null) => {
    stripRef.current.sel = n;
    setStripSel(n);
  };
  useEffect(() => {
    if (stripSel != null && stripSel >= rows.length) pickStrip(rows.length ? rows.length - 1 : null);
  }, [rows.length, stripSel]);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const tasks = await session.liveTasks();
        if (stopped) return;
        const agents = tasks.filter((t) => t.kind === "agent").length;
        const commands = tasks.length - agents;
        setRunning((r) => (r.agents === agents && r.commands === commands ? r : { agents, commands }));
        setLiveTasks((prev) => (prev.length === 0 && tasks.length === 0 ? prev : tasks));
      } catch {
        /* the count just doesn't move */
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [session]);

  // MCP servers on in this folder, for the border: read at start and whenever
  // a popup closes (that is where they are added or switched).
  const [mcpOn, setMcpOn] = useState(0);
  const refreshMcp = () => {
    if (!services) return; // the real database loads lazily; a fake decides in tests
    void services.mcp
      .list(session.appId)
      .then((l) => setMcpOn(l.filter((m) => m.enabled).length))
      .catch(() => {});
  };
  useEffect(() => {
    if (!host.open) refreshMcp();
  }, [host.open]);

  // A warning from Node or a library is shown, not swallowed: as a toast, so
  // it is readable and doesn't print over the screen (stderr goes to the log
  // while the screen is up; see run.tsx).
  // The exception: the AI SDK's "this setting is not supported, so it was left
  // out" notices. The request went through as intended, so they go to the log only.
  useEffect(() => {
    const onWarning = (w: Error) => {
      if (/AI SDK Warning/.test(w.message) && /not supported/i.test(w.message)) {
        console.error(`${w.name}: ${w.message}`);
        return;
      }
      flash(`${w.name}: ${w.message}`.slice(0, 300), 10_000, "warn");
    };
    process.on("warning", onWarning);
    return () => void process.off("warning", onWarning);
  }, []);

  // Usage analytics: the app's question, asked once if neither the app nor the
  // terminal has had an answer (the setting is shared), then left alone.
  useEffect(() => {
    if (!services) return; // tests that don't pass services never ask
    void services.analytics
      .consent()
      .then((c) => {
        services.analytics.track("cli_opened", { version, os: process.platform });
        if (c === "unset" && !host.open) openAnalytics(screen(), true);
      })
      .catch(() => {});
  }, []);

  // Notifications (Codex's): when a turn ends, or Atlarix needs an approval or
  // an answer, while this terminal isn't the focused window. OSC 9 shows as a
  // system notification in iTerm2, Ghostty, WezTerm, kitty and Windows
  // Terminal; the bell after it makes other terminals flash or bounce.
  const terminalFocused = useRef(true);
  // The session recap (lib/recap/rules.ts): written while you're away, shown when you're back.
  const recapClock = useRef<RecapClock>({ completedTurns: 0, lastTurnEndedAt: null, recappedAfterTurn: -1 });
  const recapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recapReady = useRef<string | null>(null);
  const recapOn = useRef(true);
  useEffect(() => {
    if (!services) return; // the real settings load lazily; tests decide without them
    void import("@/lib/recap/recap").then((m) => m.recapEnabled()).then((on) => void (recapOn.current = on), () => {});
  }, [services]);
  const makeRecap = async () => {
    recapClock.current.recappedAfterTurn = recapClock.current.completedTurns;
    const text = await session.recap().catch(() => null);
    if (!text) return;
    if (terminalFocused.current) session.showRecap(text);
    else recapReady.current = text;
  };
  const armRecap = () => {
    if (recapTimer.current) clearTimeout(recapTimer.current);
    recapTimer.current = null;
    const d = recapDecision({
      ...recapClock.current,
      enabled: recapOn.current,
      present: terminalFocused.current,
      busy: session.state.busy,
      now: Date.now(),
    });
    if (d.kind === "wait") recapTimer.current = setTimeout(armRecap, d.ms);
    else if (d.kind === "now") void makeRecap();
  };
  useEffect(() => () => void (recapTimer.current && clearTimeout(recapTimer.current)), []);
  useEffect(() => {
    const onFocus = () => {
      terminalFocused.current = true;
      if (recapTimer.current) clearTimeout(recapTimer.current);
      recapTimer.current = null;
      if (recapReady.current) {
        session.showRecap(recapReady.current);
        recapReady.current = null;
      }
    };
    const onBlur = () => {
      terminalFocused.current = false;
      armRecap();
    };
    renderer.on("focus", onFocus);
    renderer.on("blur", onBlur);
    return () => {
      renderer.off("focus", onFocus);
      renderer.off("blur", onBlur);
    };
  }, [renderer]);
  const notify = (message: string) => {
    if (terminalFocused.current || live.current.cliState.notifications === false) return;
    try {
      termWrite(renderer, `\x1b]9;${message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200)}\x07\x07`);
    } catch {
      /* a notification is never worth an error */
    }
  };
  // Commands typed while a turn runs that change the conversation itself wait
  // for the turn to end; messages typed after them still go in first
  // (Claude Code's queue; owner, 2026-10-05). ctrl+s stops the turn to run them now.
  const runCommandRef = useRef<((name: string, rest: string) => void) | null>(null);
  const [deferred, setDeferred] = useState<Array<{ id: number; name: string; rest: string }>>([]);
  const deferredRef = useRef(deferred);
  deferredRef.current = deferred;
  useEffect(() => {
    if (state.busy || !deferred.length) return;
    const [next, ...rest] = deferred;
    setDeferred(rest);
    runCommandRef.current?.(next!.name, next!.rest);
  }, [state.busy, deferred]);
  // The optional session rating (session-rating.ts): asked once, rarely.
  const [turnsDone, setTurnsDone] = useState(0);
  const [consent, setConsent] = useState<"opted_in" | "opted_out" | "unset" | null>(null);
  const ratingSampled = useRef(Math.random() < ratingChance);
  const [ratingDone, setRatingDone] = useState(false);
  useEffect(() => {
    if (!services) return; // the real settings load lazily; a fake decides in tests
    void services.analytics.consent().then(setConsent, () => {});
  }, [services]);
  // The header's plan label. Network-backed, so it fills in after the first paint.
  useEffect(() => {
    if (!services?.account.kind) return;
    void services.account.kind().then(setAccountKind, () => {});
  }, [services]);
  const askRating =
    !ratingDone &&
    !state.busy &&
    !host.open &&
    !draft &&
    shouldAskRating({ consent, turns: turnsDone, ratedAt: cliState.ratedAt, now: Date.now(), sampled: ratingSampled.current });
  const answerRating = (key: "0" | "1" | "2" | "3") => {
    setRatingDone(true);
    const next = { ...live.current.cliState, ratedAt: Date.now() };
    live.current.cliState = next;
    setCliState(next);
    models?.save({ ...next, deepThinking: live.current.deep });
    if (key === "0") return;
    svc().analytics.track("cli_session_rating", {
      rating: RATINGS[key],
      mode: state.mode,
      model: modelLabel,
      turns: turnsDone,
      version,
    });
    flash("Thanks. That helps us make Atlarix better.");
  };
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !state.busy && !state.lastError) setTurnsDone((n) => n + 1);
    if (wasBusy.current && !state.busy) {
      notify(state.lastError ? "Atlarix stopped: something went wrong" : `Atlarix finished${state.title ? `: ${state.title}` : ""}`);
      recapClock.current.completedTurns++;
      recapClock.current.lastTurnEndedAt = Date.now();
      recapReady.current = null;
      if (!terminalFocused.current) armRecap();
    }
    wasBusy.current = state.busy;
  }, [state.busy]);
  useEffect(() => {
    if (state.approvals.length) notify("Atlarix needs your OK to continue");
  }, [state.approvals.length]);
  useEffect(() => {
    if (state.question) notify("Atlarix has a question for you");
  }, [state.question?.questionId]);

  // The tab title pulses while Atlarix works (tab-title.ts).
  const waiting = state.approvals.length > 0 || state.question != null;
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    const write = (frame: number) => {
      try {
        termWrite(renderer, titleSequence(tabTitle({ busy: state.busy, waiting, title: state.title }, frame)));
      } catch {
        /* a title is never worth an error */
      }
    };
    write(0);
    if (!state.busy || waiting) return;
    let frame = 0;
    const t = setInterval(() => write(++frame), TAB_FRAME_MS);
    return () => clearInterval(t);
  }, [state.busy, waiting, state.title, renderer]);

  // The background update: a toast while it installs, then a notice that
  // stays above the prompt box ("Update installed · restart to use v14.53.0").
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  useEffect(() => {
    autoUpdate?.((e) => {
      if (e.kind === "installing") flash(`Updating to v${e.version}…`, 30_000);
      else if (e.kind === "installed") {
        setUpdateNotice(`✓ Update installed · restart to use v${e.version}`);
        flash(`Updated to v${e.version}. It starts next time you open Atlarix.`, 6000, "success");
      } else if (e.kind === "available") setUpdateNotice(`Update available: v${e.version} · ${e.how}`);
      else flash(`Couldn't update to v${e.version}: ${e.error}`, 10_000, "error");
    });
  }, []);

  // One tip per turn, held still while it runs (tips.ts).
  const turnCount = useRef(0);
  const [tip, setTip] = useState<Tip>(() => pickTip(`welcome:${Date.now()}`));
  useEffect(() => {
    if (state.busy) setTip(pickTip(`${session.sessionId}:${++turnCount.current}:${Date.now()}`));
  }, [state.busy]);

  const approval = state.approvals[0] ?? null;
  const palette = useMemo(
    () => (!approval && draft.startsWith("/") && !draft.includes("\n") ? matchCommands(draft) : []),
    [draft, approval],
  );

  /**
   * /model (opencode's picker): Favourites, Recent, then each provider, Atlarix
   * first; "Free" or the context size on the right; type to search all of them.
   * ctrl+a connects a provider and comes back to its models; ctrl+f favourites.
   * `only`: just that provider's models (straight after connecting it).
   */
  const openPicker = (only?: string) => {
    if (!models) return flash("This session uses the local endpoint's one model.");
    const byId = new Map<string, ModelOption>();
    const idOf = (section: string, o: ModelRef) => `${section}|${o.provider}|${o.name}`;
    const rows = (all: ModelOption[], st: CliState): ListItem[] => {
      byId.clear();
      const out: ListItem[] = [];
      const list = only ? all.filter((o) => o.provider === only) : all;
      for (const g of groupOptions(list, st)) {
        out.push({ id: `h:${g.id}`, label: g.title, header: true });
        // Each model once (groupOptions); Favourites and Recent rows name their provider.
        const alias = g.id === "favorites" || g.id === "recent";
        for (const o of g.options) {
          const id = idOf(g.id, o);
          byId.set(id, o);
          const isCurrent = st.model?.provider === o.provider && st.model?.name === o.name;
          const fav = st.favorites.some((f) => f.provider === o.provider && f.name === o.name);
          out.push({
            id,
            label: o.label,
            detail: alias ? o.providerName : undefined,
            keywords: `${o.providerName} ${o.name}`,
            gutter: isCurrent ? { text: "●", tone: "accent" } : fav ? { text: "★", tone: "warn" } : undefined,
            right: o.free ? { text: "Free", tone: "accent" } : o.context ? { text: o.context, tone: "muted" } : undefined,
          });
        }
      }
      return out;
    };
    let all: ModelOption[] = [];
    const st0 = live.current.cliState;
    const dialog: ListDialog = new ListDialog({
      title: only ? `${only} models` : "Select model",
      searchable: true,
      wide: true,
      empty: only ? "No models for it yet." : "No model matches.",
      initialId: st0.model ? idOf("recent", st0.model) : undefined,
      hints: [
        { title: "Connect provider", key: "ctrl+a" },
        { title: "Favourite", key: "ctrl+f" },
        { title: "Deep thinking", key: "ctrl+t" },
      ],
      footer: "",
      // Reloaded on every open: the hosted Core lineup (and Auto) can land after the first one.
      items: async () => {
        all = await models.load();
        if (only) {
          const name = all.find((o) => o.provider === only)?.providerName;
          if (name) dialog.retitle(`${name} models`);
        }
        return rows(all, live.current.cliState);
      },
      onChoose: (item) => {
        const o = byId.get(item.id);
        if (o) chooseModel(o);
      },
      ctrlActions: {
        a: () => {
          host.closeAll();
          openConnect(screen(), (providerId) => openPicker(providerId));
        },
        f: (item) => {
          const o = byId.get(item.id);
          if (!o) return;
          const next = toggleFavorite(live.current.cliState, { provider: o.provider, name: o.name });
          live.current.cliState = next;
          setCliState(next);
          models.save({ ...next, deepThinking: live.current.deep });
          dialog.setItems(rows(all, next));
        },
      },
    });
    host.push(dialog);
  };

  const chooseModel = (o: ModelOption) => {
    if (!models) return;
    const next = rememberChoice(live.current.cliState, { provider: o.provider, name: o.name });
    setCliState(next);
    models.save({ ...next, deepThinking: live.current.deep });
    models.choose({ provider: o.provider, name: o.name });
    setModelLabel(o.label);
    host.closeAll();
    flash(`Using ${o.label}.`, 2500, "success");
  };

  /** ctrl+p: every command, searchable; enter runs it. */
  const openCommandList = () => {
    host.push(
      new ListDialog({
        title: "Commands",
        searchable: true,
        wide: true,
        footer: "type to search · enter run · esc close",
        items: COMMANDS.filter((c) => !c.alias).map((c) => ({ id: c.name, label: c.name.padEnd(14), detail: c.description, keywords: c.group })),
        onChoose: (item) => {
          host.closeAll();
          runCommand(item.id, "");
        },
      }),
    );
  };

  const toastSeq = useRef(0);
  const flash = (text: string, ms = 4000, variant: ToastVariant = "info") => {
    const seq = ++toastSeq.current;
    setToast({ message: text, variant });
    setTimeout(() => {
      if (seq === toastSeq.current) setToast(null);
    }, ms);
  };

  // The real services load the database only when a method is called.
  const svc = (): CliServices => services ?? realServices;
  const screen = (): ScreenContext => ({
    host,
    session,
    services: svc(),
    flash,
    focusComposer: (text) => {
      if (text) composer.current?.setText(text);
      composer.current?.focus();
    },
    modelLabel: () => (live.current.deep ? `${live.current.modelLabel} · deep` : live.current.modelLabel),
    version,
    chromeStatus: chromeStatus ?? (() => "not connected"),
    copy: (text) => (copy ? copy(text) : copyText(text, renderer)),
    open: openUrl ?? ((target) => void import("../auth/account").then((m) => m.openInBrowser(target))),
    beginEdit: (e, text) => {
      setEdit(e);
      composer.current?.setText(text);
      composer.current?.focus();
    },
    signIn: signIn ?? (() => Promise.reject(new Error("Sign-in isn't available here."))),
  });
  const guard = (p: Promise<unknown> | void) =>
    void Promise.resolve(p).catch((e) => flash(e instanceof Error ? e.message : String(e)));

  // The session raised something that needs an answer: open it.
  useEffect(() => {
    if (!state.question || host.open) return;
    autoPrompt.current = "question";
    openQuestions(screen(), state.question);
  }, [state.question?.questionId]);
  // A plan waiting to be built is pinned above the box (PlanPanel), redrawn
  // whenever Atlarix writes to it; esc hides it until it changes or /plan.
  const [pinnedPlan, setPinnedPlan] = useState<PinnedPlan | null>(null);
  const [planHidden, setPlanHidden] = useState(false);
  const planScroll = useRef<PlanScroll | null>(null);
  useEffect(() => {
    const ready = state.planReady;
    if (!ready) return setPinnedPlan(null);
    let live = true;
    setPlanHidden(false);
    void session
      .plans()
      .then((plans) => {
        const p = plans.find((x) => x.id === ready.planId);
        if (live) setPinnedPlan(p && p.status === "plan" ? { id: p.id, title: p.title || ready.title, status: p.status, content: p.content } : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [state.planReady?.planId, state.planRevision]);
  const planShown = pinnedPlan != null && !planHidden;
  const buildPinned = () => {
    if (!pinnedPlan) return;
    setPinnedPlan(null);
    void session.buildPlan(pinnedPlan.id);
  };
  useEffect(() => {
    if (!state.mcpConsent) return;
    // The agent is blocked on it: it goes over any open screen.
    autoPrompt.current = "mcp";
    openMcpConsent(screen());
  }, [state.mcpConsent?.requestId]);
  useEffect(() => {
    if (!state.lastError?.includes(AUTO_CONSENT_MARKER) || host.open) return;
    autoPrompt.current = "consent";
    openAutoConsent(screen());
  }, [state.lastError]);

  useEffect(() => {
    if (startWith) runCommand(startWith);
  }, []);

  runCommandRef.current = (name, rest) => runCommand(name, rest, true);
  const runCommand = (name: string, rest = "", afterTurn = false) => {
    if (!afterTurn && state.busy && AFTER_TURN.has(name)) {
      composer.current?.clear();
      setDeferred((d) => [...d, { id: Date.now(), name, rest }]);
      return;
    }
    // The command's name only, never what followed it.
    svc().analytics.track("cli_command", { command: name });
    composer.current?.clear();
    const ctx = screen();
    switch (name) {
      case "/resume":
        return openResume(ctx);
      case "/compact":
        return guard(runCompact(ctx));
      case "/undo":
        return openRewind(ctx);
      case "/plan":
        if (!rest.trim() && pinnedPlan && planHidden) return setPlanHidden(false);
        return guard(openPlan(ctx, rest));
      case "/build":
        if (pinnedPlan) return buildPinned();
        if (state.planReady) return void session.buildPlan(state.planReady.planId);
        return flash("No plan is waiting to be built. /plan lists this session's plans.");
      case "/export":
        try {
          return flash(runExport(ctx, rest), 8000);
        } catch (e) {
          return flash(`Couldn't export: ${e instanceof Error ? e.message : String(e)}`);
        }
      case "/import":
        return guard(runImport(ctx, rest));
      case "/tasks":
      case "/agents":
        return openTasks(ctx);
      case "/btw":
        return openAside(ctx, rest);
      case "/editor": {
        if (!session.sessionId) return flash("Send a message first: there's no chat to open yet.", 3500);
        void import("@/lib/peers/open-in-editor").then(({ openInEditor }) =>
          openInEditor(session.sessionId, session.workspaceDir, rest.trim() || undefined).then((r) =>
            r.ok
              ? flash(`Opening in ${r.editor}. The Atlarix extension picks up this chat (install it from the Extensions view if it doesn't).`, 6000)
              : flash(r.error ?? `Couldn't open ${r.editor}.`, 6000, "error"),
          ),
        );
        return;
      }
      case "/recap": {
        const arg = rest.toLowerCase();
        if (arg === "on" || arg === "off") {
          recapOn.current = arg === "on";
          void import("@/lib/recap/recap").then((m) => m.setRecapEnabled(arg === "on"));
          return flash(arg === "on" ? "Session recap on: a line on where things stand when you come back." : "Session recap off. /recap still writes one when you ask.", 4000);
        }
        if (state.busy) return flash("A turn is running; ask for a recap when it's done.", 3000);
        flash("Writing a recap…", 2000);
        return void session.recap({ force: true }).then(
          (text) => (text ? session.showRecap(text) : flash("Nothing to recap yet.", 3000)),
          () => flash("The recap didn't come back.", 3000, "error"),
        );
      }
      case "/rename":
        return openRename(ctx, rest);
      case "/handoff":
        flash("Handing this session to the Atlarix app…", 4000);
        return void session
          .handoffToApp()
          .then(() => flash("Continued in the Atlarix app. It's the same session: you can keep going here too.", 8000))
          .catch((e: Error) => flash(e.message, 8000, "error"));
      case "/relics":
        return openRelics(ctx);
      case "/automations":
        return openAutomations(ctx);
      case "/mcp":
        return openMcp(ctx);
      case "/permissions":
        return openPermissions(ctx);
      case "/connect":
        return openConnect(ctx, (providerId) => openPicker(providerId));
      case "/chrome":
        return openChrome(ctx);
      case "/notifications": {
        const on = live.current.cliState.notifications === false;
        const next = { ...live.current.cliState, notifications: on };
        setCliState(next);
        models?.save({ ...next, deepThinking: live.current.deep });
        return flash(on ? "Notifications on: you'll hear when a turn ends or needs you." : "Notifications off.", 3000);
      }
      case "/analytics":
        return openAnalytics(ctx);
      case "/billing":
      case "/upgrade":
        return openBilling(ctx);
      case "/status":
        return openStatus(ctx);
      case "/login":
        return guard(openLogin(ctx));
      case "/logout":
        return openLogout(ctx);
      case "/new":
        void session.newSession();
        flash("New session.");
        return;
      case "/mode":
        host.push(
          new ListDialog({
            title: "Mode",
            footer: "↑↓ move · enter choose · shift+tab cycles · esc close",
            items: MODES.map((m) => ({
              id: m,
              label: MODE_LABEL[m],
              detail: MODE_HINT[m],
              badge: m === session.state.mode ? { text: "●", tone: "accent" as const } : undefined,
            })),
            onChoose: (item) => {
              host.closeAll();
              session.setMode(item.id as WorkMode);
            },
          }),
        );
        return;
      case "/help":
        setShowHelp(true);
        return;
      case "/model":
      case "/models":
        openPicker();
        return;
      case "/quit":
      case "/exit":
        onQuit();
        return;
    }
  };

  // useKeyboard keeps the FIRST handler it is given, so a handler that closes
  // over render-time values reads them stale forever (Tab saw "not busy" in the
  // middle of a turn). It reads everything through this ref instead.
  const live = useRef({ state, approval, palette, paletteIndex, approvalIndex, quitArmed, runCommand, showHelp, cliState, deep, modelLabel, expanded });
  live.current = { state, approval, palette, paletteIndex, approvalIndex, quitArmed, runCommand, showHelp, cliState, deep, modelLabel, expanded };

  useKeyboard((key) => {
    const { palette, paletteIndex, approvalIndex, quitArmed, runCommand, showHelp, cliState, deep } = live.current;
    // An open dialog owns the keyboard (an approval still comes first: the agent is waiting on it).
    if (host.open && !session.state.approvals.length) {
      key.preventDefault();
      if (key.name === "c" && key.ctrl) return host.closeAll();
      // ctrl+t works inside /model too (its footer offers it).
      if (!(key.name === "t" && key.ctrl)) {
        host.key(key);
        return;
      }
    }
    // The detail view (ctrl+o) is a screen of its own: ctrl+o or esc leaves it.
    if (live.current.expanded && !session.state.approvals.length) {
      if ((key.name === "o" && key.ctrl) || key.name === "escape") {
        key.preventDefault();
        setExpanded(false);
        return;
      }
      if (!(key.name === "c" && key.ctrl)) {
        key.preventDefault();
        return;
      }
    }
    // ctrl+p: every command, as a list (opencode's command palette).
    if (key.name === "p" && key.ctrl && !host.open) {
      key.preventDefault();
      return openCommandList();
    }
    const mention = mentionRef.current;
    if (mention && !live.current.approval) {
      if (key.name === "up" || key.name === "down") {
        const n = mention.matches.length;
        setMention({ ...mention, index: (mention.index + (key.name === "up" ? n - 1 : 1)) % n });
        key.preventDefault();
        return;
      }
      // Plain tab or enter takes the suggestion; shift+tab still switches the
      // mode (it was swallowed here while a menu was open).
      if ((key.name === "tab" && !key.shift) || key.name === "return") {
        chooseMention(mention.matches[mention.index]!);
        key.preventDefault();
        return;
      }
      if (key.name === "escape") {
        mentionSeq.current++;
        setMention(null);
        key.preventDefault();
        return;
      }
    }
    if (key.name === "t" && key.ctrl) {
      key.preventDefault();
      if (!models) return;
      const on = !deep;
      setDeep(on);
      models.setDeepThinking(on);
      models.save({ ...cliState, deepThinking: on });
      flash(on ? "Deep thinking on: the model thinks at its ceiling." : "Deep thinking off.");
      return;
    }
    if (showHelp) {
      setShowHelp(false);
      key.preventDefault();
      return;
    }
    // The session, not React state, is the truth for busy / mode / approvals:
    // a key can arrive before React has rendered the change that announced them.
    const state = session.state;
    const approval = state.approvals[0] ?? null;
    // The permission prompt owns the keyboard while it is up.
    if (approval) {
      const choices = approvalChoices(approval);
      if (key.name === "up") setApprovalIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down") setApprovalIndex((i) => Math.min(choices.length - 1, i + 1));
      else if (/^[1-9]$/.test(key.name) && Number(key.name) <= choices.length) {
        void session.answerApproval(approval.operationId, choices[Number(key.name) - 1]!.mode);
        setApprovalIndex(0);
      } else if (!key.ctrl && !key.meta && choices.some((c) => approvalKey(c) === key.name)) {
        void session.answerApproval(approval.operationId, choices.find((c) => approvalKey(c) === key.name)!.mode);
        setApprovalIndex(0);
      } else if (key.name === "return") {
        void session.answerApproval(approval.operationId, choices[approvalIndex]!.mode);
        setApprovalIndex(0);
      } else if (key.name === "escape") {
        void session.answerApproval(approval.operationId, "deny");
        setApprovalIndex(0);
      }
      key.preventDefault();
      return;
    }

    if (palette.length > 0) {
      if (key.name === "up") {
        setPaletteIndex((i) => Math.max(0, i - 1));
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        setPaletteIndex((i) => Math.min(palette.length - 1, i + 1));
        key.preventDefault();
        return;
      }
      // Plain tab or enter takes the suggestion; shift+tab still switches the
      // mode (it was swallowed here while a menu was open).
      if ((key.name === "tab" && !key.shift) || key.name === "return") {
        const typed = parseCommandLine(composer.current?.text() ?? "");
        const chosen = palette[Math.min(paletteIndex, palette.length - 1)]!.name;
        runCommand(chosen, typed?.name === chosen ? typed.rest : "");
        setPaletteIndex(0);
        key.preventDefault();
        return;
      }
      if (key.name === "escape") {
        composer.current?.clear();
        key.preventDefault();
        return;
      }
    }

    // A strip row is picked: ↑↓ move (↑ from the first goes back to the box),
    // enter opens its details, x stops it, esc goes back.
    const strip = stripRef.current;
    if (strip.sel != null) {
      key.preventDefault();
      const r = strip.rows[strip.sel];
      if (key.name === "escape" || (key.name === "up" && strip.sel === 0)) return pickStrip(null);
      if (key.name === "up") return pickStrip(strip.sel - 1);
      if (key.name === "down") return pickStrip(Math.min(strip.rows.length - 1, strip.sel + 1));
      if (key.name === "return" && r) {
        pickStrip(null);
        if (r.kind === "agent") return openTaskDetails(screen(), r.task.id);
        return r.tasks.length === 1 ? openTaskDetails(screen(), r.tasks[0]!.id) : openTasks(screen());
      }
      if (key.name === "x" && r) {
        if (r.kind === "agent") void session.stopTask(r.task).then((said) => flash(said));
        else if (r.tasks.length === 1) void session.stopTask(r.tasks[0]!).then((said) => flash(said));
        else {
          pickStrip(null);
          openTasks(screen());
        }
        return;
      }
      if (key.name === "c" && key.ctrl) return pickStrip(null);
      return;
    }

    // ↓ in an empty box (not browsing history) picks the first running task.
    if (key.name === "down" && !key.meta && !key.option && !key.shift && !key.ctrl && strip.rows.length > 0) {
      const current = composer.current?.text() ?? "";
      if (current === "" && historyIndex.current == null) {
        key.preventDefault();
        return pickStrip(0);
      }
    }

    // ↑/↓ recall sent prompts when the box is empty or already showing one.
    if ((key.name === "up" || key.name === "down") && !key.meta && !key.option && !key.shift && !key.ctrl) {
      const current = composer.current?.text() ?? "";
      const browsing = historyIndex.current != null && current === history.current[historyIndex.current];
      if ((current === "" && key.name === "up") || browsing) {
        const h = history.current;
        let i = historyIndex.current ?? h.length;
        i = key.name === "up" ? Math.max(0, i - 1) : i + 1;
        if (h.length === 0) return;
        key.preventDefault();
        if (i >= h.length) {
          historyIndex.current = null;
          composer.current?.clear();
        } else {
          historyIndex.current = i;
          composer.current?.setText(h[i]!);
        }
        return;
      }
    }

    if (key.name === "c" && key.ctrl) {
      key.preventDefault();
      if (editRef.current) {
        setEdit(null);
        composer.current?.clear();
        flash("Edit cancelled: nothing changed.");
        return;
      }
      if (composer.current?.text()) {
        composer.current.clear();
        setQuitArmed(false);
        return;
      }
      if (quitArmed) return onQuit();
      setQuitArmed(true);
      setTimeout(() => setQuitArmed(false), 2000);
      return;
    }
    if (askRating && !key.ctrl && !key.meta && ["0", "1", "2", "3"].includes(key.name ?? "")) {
      key.preventDefault();
      return answerRating(key.name as "0" | "1" | "2" | "3");
    }
    if (planShown && !host.open && (key.name === "pageup" || key.name === "pagedown")) {
      key.preventDefault();
      return planScroll.current?.(key.name === "pageup" ? -5 : 5);
    }
    if (planShown && key.name === "escape" && !state.busy && !host.open && !composer.current?.text()) {
      key.preventDefault();
      return setPlanHidden(true);
    }
    if (key.ctrl && key.name === "s" && deferredRef.current.length && state.busy) {
      key.preventDefault();
      // Stop the turn; the waiting command runs as it ends.
      return void session.interrupt();
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (session.stopShell) return session.stopShell();
      if (state.busy) return void session.interrupt();
      // esc esc on an empty box: go back to an earlier message (Claude Code, Codex).
      if (!composer.current?.text()) {
        const now = Date.now();
        if (now - lastEscAt.current < 700) {
          lastEscAt.current = 0;
          openRewind(screen());
        } else lastEscAt.current = now;
      }
      return;
    }
    if (key.name === "tab" && key.shift) {
      session.setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]!);
      key.preventDefault();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      const s = composer.current?.submission();
      if (!s?.display) return;
      composer.current?.clear();
      remember(s.display);
      if (state.busy) session.queueNext(s.prompt);
      else void session.submit(s.prompt, { display: s.display, images: s.images });
      return;
    }
    if (key.name === "up" && (key.meta || key.option)) {
      const text = session.popLastQueued();
      if (text) composer.current?.setText(text);
      key.preventDefault();
      return;
    }
    // ctrl+]: open the last relic of this session (its link, or the local file).
    // A terminal sends ctrl+] as the single byte 0x1d.
    if ((key.name === "]" && key.ctrl) || key.sequence === "\x1d") {
      key.preventDefault();
      const last = lastRelic(session.state.cells);
      if (!last) return flash("No relic in this session yet. /relics lists them all.");
      void import("../auth/account").then((m) => m.openInBrowser(last));
      return flash(`Opening ${last}`);
    }
    if (key.name === "o" && key.ctrl) {
      setExpanded((e) => !e);
      key.preventDefault();
    }
  });

  const onSubmit = (s: { prompt: string; display: string; images: Array<{ path: string; mime: string; label: string }> }) => {
    const command = parseCommandLine(s.display);
    if (command) {
      remember(s.display);
      return runCommand(command.name, command.rest);
    }
    // "/something" that is no command: say so, never send it to the model as a
    // message (it answered "/commands" with a page of guesses). "/" alone, or
    // "/commands", opens the list.
    const slash = /^\/(\S*)\s*$/.exec(s.display.trim());
    if (slash && !s.display.trim().includes("/", 1)) {
      composer.current?.clear();
      if (!slash[1] || slash[1] === "commands") {
        composer.current?.setText("/");
        return;
      }
      flash(`There's no /${slash[1]} command. Type / to see them all.`);
      return;
    }
    const editing = editRef.current;
    if (editing) {
      composer.current?.clear();
      remember(s.display);
      setEdit(null);
      void session.resendEdited(editing.messageId, s.prompt, editing.restoreTurnIds).then(
        ({ restoredFiles }) => restoredFiles > 0 && flash(`Restored ${restoredFiles} file${restoredFiles === 1 ? "" : "s"} · sent your edited message.`),
        (e) => flash(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    const shell = parseShellInput(s.display);
    if (shell) {
      composer.current?.clear();
      remember(s.display);
      void session.runShell(shell);
      return;
    }
    composer.current?.clear();
    remember(s.display);
    void session.submit(s.prompt, { display: s.display, images: s.images });
  };

  const activity = activityLabel(state);
  const working = activity != null;
  const narrow = width < 100;
  const statusLeft = [
    MODE_LABEL[state.mode],
    deep ? `${modelLabel} · deep` : modelLabel,
    // How full the context is, as a share AND as tokens of the window. The
    // session's running total sat here too and read as a contradiction ("23%"
    // next to "4747k tokens": each turn re-sends the context, so the total
    // passes the window). That total is in /status (owner, 2026-10-05).
    contextLabel(state),
    state.automationUnread > 0 ? `${state.automationUnread} automation result${state.automationUnread === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const topView = host.top?.view() ?? null;

  // ctrl+o: everything in full (every thought, output and diff), on a screen of
  // its own; the conversation underneath stays compact (Claude Code's transcript view).
  if (expanded && !state.approvals.length) {
    return (
      <box flexDirection="column" height="100%" backgroundColor={color.bg} paddingLeft={1} paddingRight={1}>
        <text flexShrink={0}>
          <span fg={color.accent}>{`${glyph.reply} `}</span>
          <span fg={color.white}>
            <b>Detail view</b>
          </span>
          <span fg={color.faint}>{" · everything in full · ctrl+o or esc to go back"}</span>
        </text>
        <box flexGrow={1} marginTop={1}>
          <Transcript cells={state.cells} expanded plain={plainMarkdown} busy={state.busy} workspace={session.workspaceDir} />
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" height="100%" backgroundColor={color.bg} paddingLeft={1} paddingRight={1} onMouseUp={refocusPrompt}>
      <box flexGrow={1} marginBottom={1}>
        <Transcript
          cells={state.cells}
          expanded={false}
          plain={plainMarkdown}
          busy={state.busy}
          workspace={session.workspaceDir}
          header={
            <SessionHeader
              version={version}
              model={deep ? `${modelLabel} · deep` : modelLabel}
              mode={MODE_LABEL[state.mode]}
              account={session.model && session.model.provider !== "compass" ? "own-key" : accountKind}
              workspace={abbreviatePath(session.workspaceDir, Math.max(12, width - 24))}
              mood={state.busy ? "working" : "rest"}
              hint={
                state.cells.length === 0 && !state.busy ? (
                  <>
                    <text fg={color.muted}>Ask anything, e.g. “fix the failing test” · /commands · @ for files</text>
                    <TipLine tip={tip} />
                  </>
                ) : undefined
              }
            />
          }
        />
      </box>

      {state.lastError ? <ErrorBlock notice={errorNotice(state.lastError)} /> : null}

      {planShown ? (
        <PlanPanel plan={pinnedPlan!} width={width} maxHeight={Math.max(6, Math.floor(height * 0.4))} plain={plainMarkdown} onBuild={buildPinned} scrollRef={planScroll} />
      ) : null}

      {deferred.length > 0 ? (
        <box flexDirection="column" flexShrink={0}>
          {deferred.map((d) => (
            <text key={d.id}>
              <span fg={color.muted}>{"↳ "}</span>
              <span fg={color.accentSoft}>{[d.name, d.rest].filter(Boolean).join(" ")}</span>
              <span fg={color.faint}>{" · runs after this turn · ctrl+s run now"}</span>
            </text>
          ))}
        </box>
      ) : null}

      {state.pending.length > 0 ? (
        <box flexDirection="column" flexShrink={0}>
          {state.pending.map((p) => {
            // A message from another session waits here too: say who sent it.
            const peer = splitPeerMessages(p.text)?.find((seg) => seg.kind === "peer");
            const shown = peer && peer.kind === "peer" ? `from ${peer.from || "another session"}: ${peer.text.trim()}` : p.text;
            return (
            <text key={p.id}>
              <span fg={p.kind === "steer" ? color.accent : color.muted}>{peer ? "↳ message" : p.kind === "steer" ? "↳ steer " : "↳ queued"}</span>{" "}
              <span fg={color.text}>{shown}</span>{" "}
              <span fg={color.faint}>{p.kind === "steer" ? "· goes in after this step" : "· sent when this turn ends"}</span>
            </text>
            );
          })}
        </box>
      ) : null}


      {working ? (
        <box flexDirection="column" flexShrink={0}>
          <WorkingLine activity={activity!} since={state.turnStartedAt} tokens={state.tokensThisTurn} cells={state.cells} />
          {narrow ? null : <TipLine tip={tip} />}
        </box>
      ) : null}
      {updateNotice ? (
        <box flexDirection="row" justifyContent="flex-end" flexShrink={0}>
          <text fg={updateNotice.startsWith("✓") ? color.accentSoft : color.warn}>{updateNotice}</text>
        </box>
      ) : null}

      {approval ? <Approval approval={approval} selected={approvalIndex} /> : null}

      {/* The agent's questions stay next to the conversation they're about. */}
      {topView && !approval && topView.kind === "list" && topView.asking ? <DialogPanel view={topView} height={height} /> : null}

      {showHelp ? (
        <box border borderStyle="rounded" borderColor={color.border} backgroundColor={color.panel} flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
          {[
            ["enter", "send · while a turn runs, steer it"],
            ["tab", "while a turn runs, queue for after it"],
            ["alt+↑", "pull the last queued message back"],
            ["↑ / ↓", "earlier prompts"],
            ["shift+enter, option+enter, ctrl+j", "new line (ctrl+j works in every terminal)"],
            ["esc", "stop the turn · close a menu"],
            ["esc esc", "go back to an earlier message (edit and resend)"],
            ["shift+tab", "Build → Explore → Plan → Debug → Review"],
            ["ctrl+t", "deep thinking on / off"],
            ["/model", "choose the model"],
            ["ctrl+o", "detail view: every thought, output and diff in full"],
            ["ctrl+p", "every command, searchable"],
            ["↓", "in an empty box: background tasks and sub-agents"],
            ["ctrl+]", "open the last relic"],
            ["ctrl+c", "clear the box · twice to quit"],
            ["/commands", "type / to list them"],
            ["@", "a file or folder"],
            ["!command", "run it yourself; Atlarix sees the output"],
          ].map(([k, v]) => (
            <text key={k}>
              <span fg={color.accent}>{k!.padEnd(22)}</span>
              <span fg={color.textDim}>{v}</span>
            </text>
          ))}
          <text fg={color.faint}>any key to close</text>
        </box>
      ) : null}

      {mention ? (
        <box border borderStyle="rounded" borderColor={color.border} backgroundColor={color.panel} flexDirection="column" flexShrink={0}>
          {mention.matches.map((e, i) => (
            <text key={e} bg={i === mention.index ? color.accentBg : undefined}>
              <span fg={i === mention.index ? color.accent : e.endsWith("/") ? color.textDim : color.text}>{e}</span>
            </text>
          ))}
        </box>
      ) : null}

      {palette.length > 0 ? (
        <box border borderStyle="rounded" borderColor={color.border} backgroundColor={color.panel} flexDirection="column" flexShrink={0}>
          {paletteWindow(palette.length, Math.min(paletteIndex, palette.length - 1)).map((i) => {
            const c = palette[i]!;
            const on = i === Math.min(paletteIndex, palette.length - 1);
            return (
              <text key={c.name} bg={on ? color.accentBg : undefined}>
                <span fg={on ? color.accent : color.text}>{c.name.padEnd(14)}</span>
                <span fg={color.textDim}>{c.description}</span>
              </text>
            );
          })}
        </box>
      ) : null}

      {edit ? (
        <text flexShrink={0}>
          <span fg={color.warn}>↺ editing an earlier message</span>
          <span fg={color.muted}>
            {edit.restoreCount ? ` · sending restores ${edit.restoreCount} file${edit.restoreCount === 1 ? "" : "s"} first` : ""} · enter resends · everything after it is replaced · ctrl+c cancels
          </span>
        </text>
      ) : null}

      {askRating ? (
        <box flexDirection="column" flexShrink={0} marginBottom={1}>
          <text>
            <span fg={color.accent}>{"● "}</span>
            <span fg={color.white}>
              <b>How is Atlarix doing this session?</b>
            </span>
            <span fg={color.faint}>{" (optional)"}</span>
          </text>
          <text>
            {"  "}
            <span fg={color.accentSoft}>1</span>
            <span fg={color.textDim}>{": Bad    "}</span>
            <span fg={color.accentSoft}>2</span>
            <span fg={color.textDim}>{": Fine    "}</span>
            <span fg={color.accentSoft}>3</span>
            <span fg={color.textDim}>{": Good    "}</span>
            <span fg={color.accentSoft}>0</span>
            <span fg={color.textDim}>{": Dismiss"}</span>
          </text>
        </box>
      ) : null}

      <Composer
        apiRef={composer}
        focused={!approval && !host.open && stripSel == null}
        borderColor={state.busy ? color.border : color.accent}
        shell={draft.trimStart().startsWith("!")}
        // Mode, model and usage sit IN the box's top border, the folder and
        // the hints in its bottom border: no separate status lines.
        title={` ${statusLeft} `}
        bottomTitle={
          quitArmed
            ? " press ctrl+c again to quit "
            : ` ${borderHints({
                  busy: state.busy,
                  queued: state.pending.some((p) => p.kind === "queued"),
                  running: running.agents + running.commands > 0,
                  narrow,
                  place: abbreviatePath(session.workspaceDir, 40),
                  mcp: mcpOn,
                  title: state.title,
                  max: width - 8,
                })} `
        }
        placeholder={state.busy ? "enter steers this turn · tab queues for after it" : "Ask Atlarix to build, fix or explain something…"}
        onChange={(t) => {
          setDraft(t);
          setPaletteIndex(0);
          updateMention();
        }}
        onSubmit={onSubmit}
      />

      {rows.length ? <AgentRows rows={rows} width={width} selected={stripSel} main={activity} /> : null}

      {topView && !approval && !(topView.kind === "list" && topView.asking) ? (
        <DialogOverlay view={topView} width={width} height={height} plain={plainMarkdown} />
      ) : null}
      {toast ? <Toast toast={toast} width={width} /> : null}
    </box>
  );
}
