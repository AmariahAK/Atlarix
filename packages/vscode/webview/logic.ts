/**
 * The chat's decisions that don't need a page: grouping and searching the
 * model list, the / and @ menus, the diff an edit shows. Pure, so they are
 * tested without a browser (src/__tests__/vscode-webview-logic.test.ts).
 */
import { diffLines } from "diff";

export interface Opt {
  value: string;
  name: string;
  description?: string | null;
  /** `atlarix.provider`: the row's provider as the chip names it (none on Atlarix). */
  _meta?: { [key: string]: unknown } | null;
}
export interface Group {
  group: string;
  name: string;
  options: Opt[];
}

/** A select option's choices as groups, whether the agent sent them grouped or flat. */
export function toGroups(options: ReadonlyArray<Opt | Group>): Group[] {
  const out: Group[] = [];
  let loose: Group | null = null;
  for (const o of options) {
    if ("options" in o) out.push(o);
    else {
      if (!loose) out.push((loose = { group: "", name: "", options: [] }));
      loose.options.push(o);
    }
  }
  return out;
}

/**
 * The provider the chip names beside the model, from the row's `_meta` (a
 * Favourites or Recent row isn't under its provider's group). Null on Atlarix,
 * and from an agent that sends none.
 */
export function chipProvider(groups: readonly Group[], value: string): string | null {
  for (const g of groups) {
    for (const o of g.options) {
      if (o.value !== value) continue;
      const p = (o._meta?.atlarix as { provider?: unknown } | undefined)?.provider;
      return typeof p === "string" && p ? p : null;
    }
  }
  return null;
}

export function flatOptions(groups: readonly Group[]): Opt[] {
  const seen = new Set<string>();
  const out: Opt[] = [];
  for (const g of groups) for (const o of g.options) if (!seen.has(o.value)) out.push(o), seen.add(o.value);
  return out;
}

/** What the picker shows for a search: every word must match the model's name, its id, or its group. */
export function filterGroups(groups: readonly Group[], query: string): Group[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return groups
    .map((g) => ({
      ...g,
      options: g.options.filter((o) => {
        const hay = `${o.name} ${o.value} ${o.description ?? ""} ${g.name}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((g) => g.options.length);
}

/** How many models a provider brings to the picker. */
export function providerModelCount(groups: readonly Group[], providerId: string): number {
  return flatOptions(groups).filter((o) => o.value.startsWith(`${providerId}/`)).length;
}

export interface Command {
  name: string;
  description?: string;
}

/** The / menu: commands that start with what's typed, then ones that contain it. */
export function filterCommands(commands: readonly Command[], typed: string): Command[] {
  const q = typed.replace(/^\//, "").toLowerCase();
  return [...commands.filter((c) => c.name.startsWith(q)), ...commands.filter((c) => !c.name.startsWith(q) && c.name.includes(q))];
}

/** The / being typed: the whole box is "/word" (no space yet). */
export function slashQuery(value: string): string | null {
  return /^\/[\w-]*$/.test(value) ? value : null;
}

/** An @ being typed at the caret, at the start of the box or after a space: where it starts and what follows it. */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[2]!.length - 1, query: m[2]! };
}

export interface ProviderLike {
  id: string;
  name: string;
  hasKey: boolean;
}

/** "Add a provider": ones without a key that match what's typed, names that start with it first. */
export function matchProviders<T extends ProviderLike>(providers: readonly T[], query: string, limit = 30): T[] {
  const q = query.trim().toLowerCase();
  const open = providers.filter((p) => !p.hasKey);
  if (!q) return [];
  const hit = (p: T) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
  const starts = (p: T) => p.name.toLowerCase().startsWith(q) || p.id.toLowerCase().startsWith(q);
  return [...open.filter((p) => starts(p)), ...open.filter((p) => !starts(p) && hit(p))].slice(0, limit);
}

/** The usual first providers, offered before anything is typed (those that exist and have no key yet). */
export const SUGGESTED_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "groq", "mistral"];

export type DiffRow = { kind: "add" | "del" | "ctx" | "gap"; text: string };

/**
 * An edit as a diff in order: what was removed and added, with `context` lines
 * around each change and a gap where unchanged lines are skipped.
 */
export function diffRows(oldText: string, newText: string, context = 2): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const part of diffLines(oldText, newText)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    const kind: DiffRow["kind"] = part.added ? "add" : part.removed ? "del" : "ctx";
    for (const text of lines) rows.push({ kind, text });
  }
  // Keep only the context near a change.
  const near = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.kind === "ctx") return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) near[j] = true;
  });
  const out: DiffRow[] = [];
  let skipped = false;
  rows.forEach((r, i) => {
    if (near[i]) {
      if (skipped && out.length) out.push({ kind: "gap", text: "⋯" });
      skipped = false;
      out.push(r);
    } else skipped = true;
  });
  return out;
}

/** Past chats' groups: Today, Yesterday, This week, then the month ("September 2026"). */
/**
 * Past chats as trees: the agent lists each child right after its parent
 * (`depth` > 0), and a tree keeps together when sorted, placed by its most
 * recently active chat, so it sits in that chat's day.
 */
export function chatTrees<T extends { updatedAt: string; depth?: number }>(
  rows: readonly T[],
  sort: "newest" | "oldest",
): Array<{ newest: string; rows: T[] }> {
  const trees: Array<{ newest: string; rows: T[] }> = [];
  for (const r of rows) {
    const last = trees.at(-1);
    if ((r.depth ?? 0) > 0 && last) {
      last.rows.push(r);
      if (new Date(r.updatedAt) > new Date(last.newest)) last.newest = r.updatedAt;
    } else trees.push({ newest: r.updatedAt, rows: [r] });
  }
  const sign = sort === "newest" ? 1 : -1;
  return trees.sort((a, b) => sign * (new Date(b.newest).getTime() - new Date(a.newest).getTime()));
}

export function dayGroup(iso: string | number | Date, now: Date = new Date()): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "Earlier";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * Whether the chat keeps its own record of a card you answered. Atlarix says
 * what you approved itself (a step after the card) when the card names a
 * command, a file or a folder outside, and a No inside a call shows on that
 * call's card: a record of either here showed every answer twice (QA E9).
 * `meta`: the card's own facts, present on permission cards only.
 */
export function recordsAnswer(
  meta: { command?: string | null; path?: string | null; outside?: string | null; details?: string[] } | undefined,
  toolCallId: string,
  denied: boolean,
): boolean {
  if (!meta) return true;
  if (denied) return toolCallId.startsWith("approval:");
  return !(meta.command || meta.path || meta.outside);
}
