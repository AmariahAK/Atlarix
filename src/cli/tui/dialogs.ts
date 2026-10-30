/**
 * The CLI's dialogs: every command screen (/resume, /automations, /status, the
 * plan prompt, ask_user …) is one of three shapes, so they share one keyboard
 * model and one look, like opencode's dialog stack:
 *
 *   list   a (searchable) list; enter chooses, letters act on the highlighted row
 *   text   read-only lines that scroll (a plan, a run's output, /status)
 *   input  one field (a name, a cron line, an API key — masked)
 *
 * A dialog is a controller: it owns its state, handles a key, and says when it
 * changed. The stack (DialogHost) is what App renders and routes keys to; App
 * itself knows nothing about any one screen. Pure apart from the callbacks, so
 * the screens are testable without a terminal.
 */
import { EventEmitter } from "node:events";

export interface KeyLike {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** `heading`: sand, for what is marked rather than warned about (a favourite's ★). */
export type Tone = "accent" | "muted" | "warn" | "error" | "text" | "heading";

export interface ListItem {
  id: string;
  label: string;
  /** Dimmer text after the label. */
  detail?: string;
  /** A short marker before the detail (●, ★, "off"). */
  badge?: { text: string; tone: Tone };
  /** A section title row: drawn, never selected. */
  header?: boolean;
  /** Extra words the search matches besides the label. */
  keywords?: string;
  /** Right-aligned on the row ("Free", "200K", "✓ on"). */
  right?: { text: string; tone: Tone };
  /** A mark before the label (✓ connected). */
  gutter?: { text: string; tone: Tone };
  /** A repeat of a row shown elsewhere in the list (Favourites, Recent): left out of search results. */
  alias?: boolean;
}

/** A key the dialog answers, shown in its footer as "Connect provider ctrl+a". */
export interface Hint {
  title: string;
  key: string;
}

export interface Line {
  text: string;
  tone?: Tone;
  bold?: boolean;
}

export type DialogView =
  | {
      kind: "list";
      title: string;
      /** Lines above the list (a question, an explanation). */
      intro?: Line[];
      items: ListItem[] | null;
      /** Index into the SELECTABLE items. */
      index: number;
      query: string | null;
      empty: string;
      footer: string;
      notice: Line | null;
      /** The type-in row after the items, when the list has one. */
      typed?: { value: string; placeholder: string; active: boolean };
      /** Atlarix is asking: drawn with the accent border. */
      asking?: boolean;
      /** Footer actions; drawn instead of `footer` when given. */
      hints?: Hint[];
      wide?: boolean;
    }
  | {
      kind: "text";
      title: string;
      lines: Line[];
      scroll: number;
      footer: string;
      notice: Line | null;
      hints?: Hint[];
      wide?: boolean;
      /** Rendered as markdown in a full-size view (a plan), instead of `lines`. */
      markdown?: string;
    }
  | { kind: "input"; title: string; intro?: Line[]; label: string; value: string; mask: boolean; footer: string; notice: Line | null };

export interface Dialog {
  view(): DialogView;
  /** True when the key was used. */
  key(k: KeyLike): boolean;
  /** Called by the host when anything inside changed. */
  onChange?: () => void;
  /**
   * Called once when the dialog leaves the stack, however it goes: esc, pop,
   * replace or closeAll. For an owner that holds something until a choice is
   * made (a staged install), so closing without choosing still lets it go.
   */
  onClose?: () => void;
}

/** A printable character from a key event, or "" (opentui reports some as names). */
export function printable(k: KeyLike): string {
  if (k.ctrl || k.meta) return "";
  if (k.name === "space") return " ";
  const ch = k.sequence?.length === 1 ? k.sequence : k.name?.length === 1 ? k.name : "";
  if (!ch || ch < " ") return "";
  return k.shift && ch.length === 1 ? ch.toUpperCase() : ch;
}

export class DialogHost extends EventEmitter {
  private stack: Dialog[] = [];

  get top(): Dialog | null {
    return this.stack.at(-1) ?? null;
  }

  get open(): boolean {
    return this.stack.length > 0;
  }

  /** Still on the stack (a live view stops refreshing once it isn't). */
  has(d: Dialog): boolean {
    return this.stack.includes(d);
  }

  push(d: Dialog): void {
    d.onChange = () => this.emit("change");
    this.stack.push(d);
    this.emit("change");
  }

  /** Close the top dialog (esc). */
  pop(): void {
    this.stack.pop()?.onClose?.();
    this.emit("change");
  }

  /** Swap the top dialog for another (a step in a form). */
  replace(d: Dialog): void {
    this.stack.pop()?.onClose?.();
    this.push(d);
  }

  closeAll(): void {
    const closed = this.stack.reverse();
    this.stack = [];
    for (const d of closed) d.onClose?.();
    this.emit("change");
  }

  key(k: KeyLike): boolean {
    const d = this.top;
    if (!d) return false;
    if (d.key(k)) return true;
    if (k.name === "escape") {
      this.pop();
      return true;
    }
    return false;
  }
}

// ─── list ────────────────────────────────────────────────────────────────────

export interface ListOptions {
  title: string;
  intro?: Line[];
  /** Items now, or a loader (the dialog shows "Loading…" until it resolves). */
  items: ListItem[] | (() => Promise<ListItem[]>);
  searchable?: boolean;
  /**
   * With `searchable`: what typing searches, when the rows shown are only a
   * page of something bigger (the MCP marketplace). The rows are replaced by
   * its answer instead of being filtered locally.
   */
  search?: (query: string) => Promise<ListItem[]>;
  /**
   * The rows after the ones shown, for the same query, asked for as the
   * highlight nears the end; an empty answer means there are no more.
   */
  more?: (query: string, have: number) => Promise<ListItem[]>;
  empty?: string;
  footer: string;
  /** Enter on a row. */
  onChoose?: (item: ListItem) => void | Promise<void>;
  /**
   * Letter keys on the highlighted row (`r` run now, `d` delete …). Return a
   * notice to show, or nothing. Only when the list is NOT searchable — there
   * letters type into the search.
   */
  actions?: Record<string, (item: ListItem) => void | string | Promise<void | string>>;
  /** Letter keys that act on the LIST, not a row (`n` new): they work on an empty list too. */
  listActions?: Record<string, () => void | string | Promise<void | string>>;
  /** Keys with ctrl, which work in searchable lists too ("f" = ctrl+f). */
  ctrlActions?: Record<string, (item: ListItem) => void | string | Promise<void | string>>;
  /**
   * A last row you type into, in place (a question's "your own answer"). While
   * it is highlighted, keys type into it and enter sends what's there; typing a
   * letter anywhere else in the list jumps to it.
   */
  typeRow?: { placeholder: string; onSubmit: (text: string) => void | string };
  /** Atlarix is asking: drawn with the accent border. */
  asking?: boolean;
  /** Footer actions, as "title key" pairs (drawn instead of `footer`). */
  hints?: Hint[];
  /** The row highlighted when it opens (the current model). */
  initialId?: string;
  /** A wider panel (long rows: models, providers). */
  wide?: boolean;
}

export function matchesQuery(item: ListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${item.label} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export class ListDialog implements Dialog {
  onChange?: () => void;
  onClose?: () => void;
  private items: ListItem[] | null = null;
  private index = 0;
  private query: string | null;
  private notice: Line | null = null;
  private typed = "";
  private title: string;

  constructor(private readonly opts: ListOptions) {
    this.title = opts.title;
    this.query = opts.searchable ? "" : null;
    if (typeof opts.items === "function") void this.reload();
    else this.setInitial(opts.items);
  }

  private setInitial(items: ListItem[]): void {
    this.items = items;
    if (this.opts.initialId) {
      const at = this.selectable().findIndex((i) => i.id === this.opts.initialId);
      if (at >= 0) this.index = at;
    }
  }

  async reload(): Promise<void> {
    if (typeof this.opts.items !== "function") return;
    try {
      const first = this.items === null;
      const items = await this.opts.items();
      if (first) this.setInitial(items);
      else this.items = items;
    } catch (e) {
      this.items = [];
      this.notice = { text: e instanceof Error ? e.message : String(e), tone: "error" };
    }
    this.index = Math.min(this.index, Math.max(0, this.selectable().length - 1));
    this.onChange?.();
  }

  retitle(title: string): void {
    this.title = title;
    this.onChange?.();
  }

  setItems(items: ListItem[]): void {
    this.items = items;
    this.index = Math.min(this.index, Math.max(0, this.selectable().length - 1));
    this.onChange?.();
  }

  say(text: string, tone: Tone = "muted"): void {
    this.notice = { text, tone };
    this.onChange?.();
  }

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;

  /** Ask `search` for the typed query, after a short pause; the latest answer wins. */
  private searchSoon(): void {
    if (!this.opts.search) return;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const q = this.query ?? "";
    const seq = ++this.searchSeq;
    this.searchTimer = setTimeout(() => {
      void this.opts.search!(q).then(
        (items) => {
          if (seq !== this.searchSeq) return;
          this.items = items;
          this.index = 0;
          this.exhausted = false;
          this.onChange?.();
        },
        () => {},
      );
    }, 200);
  }

  private loadingMore = false;
  private exhausted = false;

  /** Near the end of what's loaded: ask `more` for the next rows (one ask at a time). */
  private moreSoon(): void {
    const more = this.opts.more;
    if (!more || this.loadingMore || this.exhausted || this.items === null) return;
    if (this.index < this.selectable().length - 5) return;
    this.loadingMore = true;
    const seq = this.searchSeq;
    void more(this.query ?? "", this.items.length).then(
      (rows) => {
        this.loadingMore = false;
        if (seq !== this.searchSeq || this.items === null) return;
        if (rows.length === 0) this.exhausted = true;
        else this.items = [...this.items, ...rows];
        this.onChange?.();
      },
      () => {
        this.loadingMore = false;
      },
    );
  }

  /** The rows shown: headers kept only when the search is empty. */
  private shown(): ListItem[] {
    const all = this.items ?? [];
    if (this.opts.search || !this.query?.trim()) return all;
    return all.filter((i) => !i.header && !i.alias && matchesQuery(i, this.query!));
  }

  private selectable(): ListItem[] {
    return this.shown().filter((i) => !i.header);
  }

  get current(): ListItem | undefined {
    const s = this.selectable();
    return s[Math.min(this.index, s.length - 1)];
  }

  view(): DialogView {
    return {
      kind: "list",
      title: this.title,
      intro: this.opts.intro,
      items: this.items === null ? null : this.shown(),
      index: this.index,
      query: this.query,
      empty: this.opts.empty ?? (this.query ? `Nothing matches “${this.query}”.` : "Nothing here yet."),
      footer: this.opts.footer,
      notice: this.notice,
      typed: this.opts.typeRow
        ? { value: this.typed, placeholder: this.opts.typeRow.placeholder, active: this.onTypeRow() }
        : undefined,
      asking: this.opts.asking,
      hints: this.opts.hints,
      wide: this.opts.wide,
    };
  }

  /** The type-in row is highlighted (it sits after the last item). */
  private onTypeRow(): boolean {
    return !!this.opts.typeRow && this.index >= this.selectable().length;
  }

  private typeKey(k: KeyLike): boolean {
    const row = this.opts.typeRow!;
    if (k.name === "return") {
      if (!this.typed.trim()) {
        this.say("Type an answer first.");
        return true;
      }
      const said = row.onSubmit(this.typed.trim());
      if (typeof said === "string") this.say(said, "error");
    } else if (k.name === "backspace") {
      this.typed = this.typed.slice(0, -1);
    } else if (k.name === "space") {
      this.typed += " ";
    } else if (printable(k)) {
      this.typed += printable(k);
    } else return false;
    this.onChange?.();
    return true;
  }

  private async act(fn: (item: ListItem) => void | string | Promise<void | string>): Promise<void> {
    const item = this.current;
    if (!item) return;
    try {
      const said = await fn(item);
      if (typeof said === "string") this.say(said);
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), "error");
    }
  }

  key(k: KeyLike): boolean {
    const items = this.selectable().length;
    const n = items + (this.opts.typeRow ? 1 : 0);
    if (this.onTypeRow() && k.name !== "up" && k.name !== "down" && k.name !== "escape" && this.typeKey(k)) return true;
    // A letter that isn't a shortcut starts your own answer.
    if (
      this.opts.typeRow &&
      this.query === null &&
      printable(k) &&
      !/^[1-9]$/.test(printable(k)) &&
      !this.opts.actions?.[printable(k)] &&
      !this.opts.listActions?.[printable(k)]
    ) {
      this.index = items;
      return this.typeKey(k);
    }
    if (k.name === "up") {
      this.index = Math.max(0, this.index - 1);
    } else if (k.name === "down") {
      this.index = Math.min(Math.max(0, n - 1), this.index + 1);
      this.moreSoon();
    } else if (k.name === "pageup") {
      this.index = Math.max(0, this.index - 10);
    } else if (k.name === "pagedown") {
      this.index = Math.min(Math.max(0, n - 1), this.index + 10);
      this.moreSoon();
    } else if (k.name === "return") {
      if (this.opts.onChoose) void this.act(async (i) => void (await this.opts.onChoose!(i)));
    } else if (k.ctrl && this.opts.ctrlActions?.[k.name]) {
      void this.act(this.opts.ctrlActions[k.name]!);
    } else if (this.query !== null && k.name === "backspace") {
      this.query = this.query.slice(0, -1);
      this.index = 0;
      this.searchSoon();
    } else if (this.query !== null && printable(k)) {
      this.query += printable(k);
      this.index = 0;
      this.searchSoon();
    } else if (this.query === null && printable(k) && this.opts.listActions?.[printable(k)]) {
      const fn = this.opts.listActions[printable(k)]!;
      void Promise.resolve()
        .then(fn)
        .then(
          (said) => typeof said === "string" && this.say(said),
          (e) => this.say(e instanceof Error ? e.message : String(e), "error"),
        );
    } else if (this.query === null && printable(k) && this.opts.actions?.[printable(k)]) {
      void this.act(this.opts.actions[printable(k)]!);
    } else {
      return false;
    }
    this.onChange?.();
    return true;
  }
}

// ─── text ────────────────────────────────────────────────────────────────────

export class TextDialog implements Dialog {
  onChange?: () => void;
  onClose?: () => void;
  private scroll = 0;
  private lines: Line[];
  private notice: Line | null = null;
  private markdown: string | undefined;
  private title: string;

  constructor(
    private readonly opts: {
      title: string;
      lines: Line[] | (() => Promise<Line[]>);
      footer?: string;
      actions?: Record<string, () => void | string | Promise<void | string>>;
      hints?: Hint[];
      wide?: boolean;
      /** Markdown to render (a plan): a full-size view that scrolls. */
      markdown?: string;
      /** ← / → (the agent view steps between sub-agents). */
      step?: (dir: -1 | 1) => void;
    },
  ) {
    this.markdown = opts.markdown;
    this.title = opts.title;
    if (typeof opts.lines === "function") {
      this.lines = [{ text: "Loading…", tone: "muted" }];
      void opts.lines().then(
        (l) => this.setLines(l),
        (e) => this.setLines([{ text: e instanceof Error ? e.message : String(e), tone: "error" }]),
      );
    } else {
      this.lines = opts.lines;
    }
  }

  setLines(lines: Line[]): void {
    this.lines = lines;
    this.onChange?.();
  }

  /** A live markdown view (a sub-agent's work) redrawn in place; `top` resets the scroll (another agent). */
  setMarkdown(markdown: string, title?: string, top = false): void {
    this.markdown = markdown;
    if (title) this.title = title;
    if (top) this.scroll = 0;
    this.onChange?.();
  }

  view(): DialogView {
    return {
      kind: "text",
      title: this.title,
      lines: this.lines,
      scroll: this.scroll,
      footer: this.opts.footer ?? "↑↓ scroll · esc close",
      hints: this.opts.hints,
      wide: this.opts.wide,
      markdown: this.markdown,
      notice: this.notice,
    };
  }

  key(k: KeyLike): boolean {
    // Markdown wraps to more rows than it has lines; the view clamps the rest.
    const max = Math.max(0, (this.markdown != null ? this.markdown.split("\n").length * 3 : this.lines.length) - 1);
    if ((k.name === "left" || k.name === "right") && this.opts.step) this.opts.step(k.name === "left" ? -1 : 1);
    else if (k.name === "up") this.scroll = Math.max(0, this.scroll - 1);
    else if (k.name === "down") this.scroll = Math.min(max, this.scroll + 1);
    else if (k.name === "pageup") this.scroll = Math.max(0, this.scroll - 10);
    else if (k.name === "pagedown" || k.name === "space") this.scroll = Math.min(max, this.scroll + 10);
    else if (printable(k) && this.opts.actions?.[printable(k)]) {
      const fn = this.opts.actions[printable(k)]!;
      // Something visible at once: a slow action (saving a page) looked like nothing happened.
      this.notice = { text: "Working…", tone: "muted" };
      void Promise.resolve()
        .then(fn)
        .then(
          (said) => {
            this.notice = typeof said === "string" ? { text: said, tone: "muted" } : null;
            this.onChange?.();
          },
          (e) => {
            this.notice = { text: e instanceof Error ? e.message : String(e), tone: "error" };
            this.onChange?.();
          },
        );
    } else return false;
    this.onChange?.();
    return true;
  }
}

// ─── input ───────────────────────────────────────────────────────────────────

export class InputDialog implements Dialog {
  onChange?: () => void;
  onClose?: () => void;
  private value: string;
  private notice: Line | null = null;

  constructor(
    private readonly opts: {
      title: string;
      intro?: Line[];
      label: string;
      initial?: string;
      mask?: boolean;
      footer?: string;
      /** Return an error to keep the dialog open with it shown. */
      onSubmit: (value: string) => void | string | Promise<void | string>;
    },
  ) {
    this.value = opts.initial ?? "";
  }

  view(): DialogView {
    return {
      kind: "input",
      title: this.opts.title,
      intro: this.opts.intro,
      label: this.opts.label,
      value: this.value,
      mask: !!this.opts.mask,
      footer: this.opts.footer ?? "enter save · esc cancel",
      notice: this.notice,
    };
  }

  /** A paste arrives whole (bracketed paste), not as keys. */
  paste(text: string): void {
    this.value += text.replace(/\r?\n/g, " ");
    this.onChange?.();
  }

  key(k: KeyLike): boolean {
    if (k.name === "return") {
      void Promise.resolve(this.opts.onSubmit(this.value)).then(
        (err) => {
          if (typeof err === "string") {
            this.notice = { text: err, tone: "error" };
            this.onChange?.();
          }
        },
        (e) => {
          this.notice = { text: e instanceof Error ? e.message : String(e), tone: "error" };
          this.onChange?.();
        },
      );
      return true;
    }
    if (k.name === "backspace") this.value = this.value.slice(0, -1);
    else if (k.name === "u" && k.ctrl) this.value = "";
    else if (printable(k)) this.value += printable(k);
    else return false;
    this.notice = null;
    this.onChange?.();
    return true;
  }
}
