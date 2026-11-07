/**
 * Every command's screen, built from the three dialog shapes (dialogs.ts).
 * App calls `openX(ctx)`; the dialog then lives on the stack until it closes.
 * Nothing here draws or reads keys directly, and nothing touches the database:
 * the session and the services do (and the tests fake both).
 */
import { keptFilesLine } from "@/lib/chat/kept-files-line";
import { joinAskUserPicks } from "@/lib/tools/ask_user_options";
import fs from "node:fs";
import { CORE_PAYMENT_SUMMARY, formatCents } from "@/shared/billing_copy";
import { activityFootnote, activitySections, activityTiles, calendarRows } from "@/lib/stats/activity-format";
import { USAGE_RANGES, USAGE_TABS, autoText, creditsText, tokensText, toolsText, type UsageTab } from "@/lib/stats/usage-format";
import { shareCardSvg } from "@/lib/stats/share-card";
import os from "node:os";
import path from "node:path";
import type { AgentSession, PendingQuestion } from "../agent/session";
import type { AutomationDraft, AutomationSummary, CliServices, SavedPermission } from "../agent/services";
import { clockFromCron, formatClock } from "@/lib/automations/cron-time";
import { formatTokens } from "./format";
import { glyph } from "./glyphs";
import { InputDialog, ListDialog, TextDialog, type Dialog, type DialogHost, type Line, type ListItem, type Tone } from "./dialogs";
import { mcpServerDetail, mcpServerRight } from "./mcp-row";
import {
  exportFileName,
  fromAtlarixMessages,
  messageContent,
  parsePortable,
  sanitizeSession,
  toMarkdown,
  type PortableSession,
} from "../sessions/portable";
import { SOURCE_NAMES, listForeignSessions, type ImportSource } from "../sessions/importers";
import { lineageNote, treeLabel } from "@/shared/session-lineage";

/** What the session offers the screens (AgentSession, or the tests' fake). */
export type ScreenSession = Pick<
  AgentSession,
  | "state"
  | "appId"
  | "workspaceDir"
  | "listSessions"
  | "rename"
  | "resume"
  | "compact"
  | "plans"
  | "earlierPlans"
  | "buildEarlierPlan"
  | "sharePlan"
  | "buildPlan"
  | "dismissPlanReady"
  | "answerQuestion"
  | "dismissQuestion"
  | "answerMcpConsent"
  | "subagentJobs"
  | "subagentOutput"
  | "cancelSubagent"
  | "liveTasks"
  | "taskOutput"
  | "stopTask"
  | "aside"
  | "exportable"
  | "importMessages"
  | "markAutomationsRead"
  | "myMessages"
  | "undoPreview"
  | "model"
>;

/** Editing an earlier message (/undo, esc esc): what the next send replaces, and whether files go back. */
export interface PendingEdit {
  messageId: number;
  restoreTurnIds: string[] | null;
  restoreCount: number;
}

export interface ScreenContext {
  host: DialogHost;
  session: ScreenSession;
  services: CliServices;
  /** A short message (a toast): how long, and its colour. */
  flash: (text: string, ms?: number, variant?: "info" | "success" | "warn" | "error") => void;
  /** Put text in the prompt box (Keep planning, an answer to type). */
  focusComposer: (text?: string) => void;
  /** The label of the model the CLI uses now. */
  modelLabel: () => string;
  version: string;
  /** Chrome: "connected", "not connected", "shared with the Atlarix app" … */
  chromeStatus: () => string;
  /** Copy text to the clipboard (OSC 52 and the system tool). */
  copy?: (text: string) => Promise<boolean>;
  /** Open a link, or a file, in the default browser. */
  open?: (target: string) => void;
  /** Start editing an earlier message: its text goes in the box; the next send replaces it. */
  beginEdit?: (edit: PendingEdit, text: string) => void;
  /** Sign in (browser, or a code over SSH); resolves with the email. */
  signIn: (show: (lines: Line[]) => void) => Promise<string>;
  now?: () => Date;
}

const ago = (t: number | Date | string, now: Date): string => {
  const ms = now.getTime() - new Date(t).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

// ─── /resume ─────────────────────────────────────────────────────────────────

export function openResume(ctx: ScreenContext): void {
  const now = ctx.now?.() ?? new Date();
  const titles = new Map<string, string>();
  ctx.host.push(
    new ListDialog({
      title: "Resume a session",
      searchable: true,
      empty: "No earlier sessions in this folder yet.",
      footer: "type to search · ↑↓ move · enter open · esc close",
      items: async () =>
        (await ctx.session.listSessions()).map((s) => {
          titles.set(s.id, s.title?.trim() || "Untitled session");
          return {
            id: s.id,
            label: treeLabel(titles.get(s.id)!, s.depth),
            detail: [
              ago(s.updatedAt, now),
              s.workMode && s.workMode !== "build" ? s.workMode : null,
              lineageNote({ origin: s.origin ?? null, depth: s.depth, runs: s.runs, parentTitle: s.parentTitle }),
            ]
              .filter(Boolean)
              .join(" · "),
          };
        }),
      onChoose: async (item) => {
        const { parent } = await ctx.session.resume(item.id);
        ctx.host.closeAll();
        ctx.flash(`Resumed “${titles.get(item.id) ?? item.label}”${parent ? `, from “${parent.title}”` : ""}.`);
      },
    }),
  );
}

// ─── /undo, esc esc ──────────────────────────────────────────────────────────

/**
 * Go back to one of your messages: choose whether the files changed since come
 * back too, then edit it in the box and send. Nothing changes until you send
 * (ctrl+c cancels), as with the app's edit.
 */
export async function openUndo(ctx: ScreenContext, messageId?: number): Promise<void> {
  if (ctx.session.state.busy) return ctx.flash("Wait for this turn to finish (or esc to stop it), then undo.");
  const mine = ctx.session.myMessages();
  const target = messageId != null ? mine.find((m) => m.id === messageId) : mine[0];
  if (!target) return ctx.flash("Nothing to undo yet.");
  const preview = await ctx.session.undoPreview(target.id);
  // A file the turn created is in both lists: named once (QA saw "f.txt, f.txt").
  const files = [...new Set([...preview.filesChanged, ...preview.createdFiles])];
  const touched = files.length;
  // Restoring leaves a file changed since alone: count what will go back.
  const keptList = preview.kept ?? [];
  const kept = new Set(keptList);
  const goingBack = files.filter((f) => !kept.has(f)).length;
  const begin = (restore: boolean) => {
    ctx.host.closeAll();
    ctx.beginEdit?.(
      { messageId: target.id, restoreTurnIds: restore ? preview.turnIds : null, restoreCount: restore ? goingBack : 0 },
      target.text,
    );
  };
  if (touched === 0) return begin(false);
  const names = files.slice(0, 5);
  ctx.host.push(
    new ListDialog({
      title: "Go back to this message?",
      intro: [
        { text: firstLineOf(target.text), bold: true },
        { text: `Atlarix changed ${touched} file${touched === 1 ? "" : "s"} after it: ${names.join(", ")}${touched > names.length ? " …" : ""}`, tone: "muted" },
        ...(keptFilesLine(keptList) ? [{ text: keptFilesLine(keptList)!, tone: "muted" as const }] : []),
      ],
      footer: "↑↓ move · enter choose · esc cancel",
      items: [
        { id: "restore", label: "Restore the files, then edit the message", detail: "as if those turns never happened" },
        { id: "keep", label: "Keep the files, edit the message" },
      ],
      onChoose: (item) => begin(item.id === "restore"),
    }),
  );
}

const firstLineOf = (t: string) => {
  const l = t.split("\n")[0] ?? "";
  return l.length > 90 ? l.slice(0, 89) + "…" : l;
};

/**
 * /undo and esc esc: pick which of your messages to go back to (Claude Code's
 * /rewind, Codex's esc esc, opencode's undo), newest first. Choosing one offers
 * to restore the files changed after it, then puts it in the box to edit.
 */
export function openRewind(ctx: ScreenContext): void {
  if (ctx.session.state.busy) return ctx.flash("Wait for this turn to finish (or esc to stop it), then undo.");
  const mine = ctx.session.myMessages();
  if (!mine.length) return ctx.flash("Nothing to undo yet.");
  // Always the list, even with one message: going straight to editing it
  // meant a stray esc esc quietly put your last prompt back in the box, ready
  // to replace the conversation (QA G1). Claude Code and Codex ask first too.
  ctx.host.push(
    new ListDialog({
      title: "Go back to a message",
      intro: [{ text: "Edit it and resend; everything after it is replaced.", tone: "muted" }],
      footer: "↑↓ move · enter choose · esc close",
      items: mine.map((m, i) => ({
        id: String(m.id),
        label: firstLineOf(m.text),
        right: { text: i === 0 ? "latest" : `${i} back`, tone: "muted" as const },
      })),
      onChoose: (item) => {
        ctx.host.closeAll();
        return openUndo(ctx, Number(item.id));
      },
    }),
  );
}

// ─── /compact ────────────────────────────────────────────────────────────────

export async function runCompact(ctx: ScreenContext): Promise<void> {
  ctx.flash("Compacting…");
  const res = await ctx.session.compact().catch((e) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
  ctx.flash(res.message);
}

// ─── /plan ───────────────────────────────────────────────────────────────────

const PLAN_STATUS: Record<string, string> = { plan: "ready to build", building: "building", built: "built" };

function planLines(content: string): Line[] {
  return content.split("\n").map((text) => {
    if (/^#{1,3}\s/.test(text)) return { text: text.replace(/^#+\s*/, ""), tone: "accent" as const, bold: true };
    if (/^\s*[-*]\s+\[x\]/i.test(text)) return { text: text.replace(/\[x\]/i, "✓"), tone: "muted" as const };
    if (/^\s*[-*]\s+\[ \]/.test(text)) return { text: text.replace("[ ]", "○") };
    return { text };
  });
}

/**
 * Save a plan as a page (a relic): a link on paid Core, a local file otherwise.
 * It said "share" and showed nothing while it worked, so it read as doing
 * nothing (owner, 2026-10-05); it now says what it made and where.
 */
async function sharePlan(ctx: ScreenContext, planId: string): Promise<string> {
  const res = await ctx.session.sharePlan(planId);
  const copied = async (t: string) => ((await ctx.copy?.(t)) ? " (copied)" : "");
  if (res.url) return `Published: ${res.url}${await copied(res.url)}`;
  if (res.path) return `Saved as a page: ${res.path}${await copied(res.path)}`;
  return res.note ?? "Couldn't save the plan as a page.";
}

function showPlan(ctx: ScreenContext, plan: { id: string; title: string; status: string; content: string }): void {
  ctx.host.push(
    new TextDialog({
      title: `${plan.title} · ${PLAN_STATUS[plan.status] ?? plan.status}`,
      lines: planLines(plan.content),
      markdown: plan.content,
      hints: [
        ...(plan.status === "plan" ? [{ title: "build it", key: "b" }] : []),
        { title: "save as page", key: "s" },
        { title: "scroll", key: "↑↓" },
      ],
      actions: {
        ...(plan.status === "plan"
          ? {
              b: async () => {
                ctx.host.closeAll();
                await ctx.session.buildPlan(plan.id);
              },
            }
          : {}),
        s: () => sharePlan(ctx, plan.id),
      },
    }),
  );
}

export async function openPlan(ctx: ScreenContext, rest = ""): Promise<void> {
  if (rest.trim() === "share") {
    const [latest] = await ctx.session.plans();
    if (!latest) return ctx.flash("No plan in this session to share.");
    ctx.flash("Saving the plan as a page…");
    return ctx.flash(await sharePlan(ctx, latest.id).catch((e) => (e instanceof Error ? e.message : String(e))));
  }
  const [plans, earlier] = await Promise.all([ctx.session.plans(), ctx.session.earlierPlans().catch(() => [])]);
  if (plans.length === 0 && earlier.length === 0) {
    ctx.flash(
      ctx.session.state.mode === "plan"
        ? "No plan yet in this folder. Describe what to build and Atlarix will plan it."
        : "No plan yet in this folder. Switch to Plan mode (shift+tab) and describe what to build.",
    );
    return;
  }
  if (plans.length === 1 && earlier.length === 0) return showPlan(ctx, plans[0]!);
  const now = ctx.now?.() ?? new Date();
  ctx.host.push(
    new ListDialog({
      title: "Plans",
      footer: "↑↓ move · enter open · esc close",
      items: [
        ...(plans.length ? [{ id: "h:this", label: "This session", header: true }] : []),
        ...plans.map((p) => ({
          id: p.id,
          label: p.title,
          badge: { text: PLAN_STATUS[p.status] ?? p.status, tone: p.status === "plan" ? ("accent" as const) : ("muted" as const) },
          detail: ago(p.createdAt, now),
        })),
        ...(earlier.length ? [{ id: "h:earlier", label: "Earlier sessions", header: true }] : []),
        ...earlier.map((p) => ({
          id: `e:${p.id}`,
          label: p.title,
          badge: { text: PLAN_STATUS[p.status] ?? p.status, tone: "muted" as const },
          detail: [p.sessionTitle?.trim() || "untitled session", ago(p.createdAt, now)].join(" · "),
        })),
      ],
      onChoose: (item) => {
        if (!item.id.startsWith("e:")) return showPlan(ctx, plans.find((p) => p.id === item.id)!);
        const p = earlier.find((x) => `e:${x.id}` === item.id)!;
        ctx.host.push(
          new TextDialog({
            title: `${p.title} · from “${p.sessionTitle?.trim() || "an earlier session"}”`,
            lines: planLines(p.content),
            markdown: p.content,
            hints: [
              { title: "build it in this session", key: "b" },
              { title: "scroll", key: "↑↓" },
            ],
            actions: {
              b: async () => {
                ctx.host.closeAll();
                await ctx.session.buildEarlierPlan(p.id);
              },
            },
          }),
        );
      },
    }),
  );
}


// ─── ask_user ────────────────────────────────────────────────────────────────


/**
 * The agent's questions, one at a time; then, when there was more than one, a
 * review of every answer, any of which can be changed, before they go back
 * together. Esc on any of them leaves them unanswered: the reply is whatever
 * is typed next.
 */
export function openQuestions(ctx: ScreenContext, q: PendingQuestion): void {
  const answers: string[] = [];
  const total = q.items.length;
  let shown = false;
  const show = (d: ListDialog | InputDialog) => {
    if (shown) ctx.host.replace(d);
    else ctx.host.push(d);
    shown = true;
  };
  const send = () => {
    // Answer FIRST: closing the dialog while the question is still pending
    // reads as "left unanswered" (App's esc handling).
    void ctx.session.answerQuestion(answers);
    ctx.host.closeAll();
  };
  const SEND = "__send__";
  const review = () =>
    show(
      new ListDialog({
        title: `Your answers (${total})`,
        asking: true,
        footer: "enter send all · ↑↓ choose one to change · 1-9 change · esc leave them",
        items: [
          { id: SEND, label: "Send all answers" },
          ...q.items.map((it, k) => ({
            id: String(k),
            label: `${k + 1}. ${it.question.split("\n")[0]!.slice(0, 60)}`,
            detail: `→ ${answers[k] ?? ""}`.slice(0, 70),
          })),
        ],
        onChoose: (choice) => (choice.id === SEND ? send() : ask(Number(choice.id), true)),
        actions: Object.fromEntries(q.items.slice(0, 9).map((_, k) => [String(k + 1), () => ask(k, true)])),
      }),
    );
  /** `changing`: back to the review afterwards, instead of on to the next question. */
  const ask = (i: number, changing = false): void => {
    if (i >= total) return total > 1 ? review() : send();
    const item = q.items[i]!;
    const base = total > 1 ? `Question ${i + 1}/${total}` : "Atlarix asks";
    const title = item.header ? `${base} · ${item.header}` : base;
    const intro: Line[] = [{ text: item.question, tone: "text", bold: true }];
    const next = (answer: string) => {
      answers[i] = answer;
      if (changing) review();
      else ask(i + 1);
    };
    const typeOwn = () =>
      show(
        new InputDialog({
          title,
          intro,
          label: "Your answer",
          footer: "enter send · esc leave it (reply in the prompt box instead)",
          onSubmit: (v) => (v.trim() ? next(v.trim()) : "Type an answer, or esc."),
        }),
      );
    const options = item.options ?? [];
    if (!options.length) return typeOwn();
    const picked = new Set<number>();
    /** A row per option: its number and label, the recommended mark, its description. */
    const rows = (): ListItem[] =>
      options.map((o, k) => ({
        id: String(k),
        // A model that numbered its own options ("1. JSON") showed "1. 1. JSON".
        label: `${k + 1}. ${o.label.replace(/^\s*\d+[.)]\s+/, "")}`,
        ...(o.recommended ? { badge: { text: "recommended", tone: "heading" as const } } : {}),
        ...(o.description ? { detail: o.description } : {}),
        ...(item.multiSelect
          ? { gutter: picked.has(k) ? { text: glyph.reply, tone: "accent" as const } : { text: glyph.tool.success, tone: "muted" as const } }
          : {}),
      }));
    if (!item.multiSelect) {
      show(
        new ListDialog({
          title,
          intro,
          asking: true,
          footer: "↑↓ move · enter choose · 1-9 pick · or just type your own · esc leave it",
          items: rows(),
          typeRow: { placeholder: "Type your own answer…", onSubmit: (v) => next(v) },
          onChoose: (choice) => next(options[Number(choice.id)]!.label),
          actions: Object.fromEntries(options.slice(0, 9).map((o, k) => [String(k + 1), () => next(o.label)])),
        }),
      );
      return;
    }
    // Several may be picked: a pick toggles, enter sends them (with your own
    // text, if you typed some), joined with ", ".
    const pickedLabels = () => options.filter((_, k) => picked.has(k)).map((o) => o.label);
    const toggle = (k: number) => {
      if (picked.has(k)) picked.delete(k);
      else picked.add(k);
      dialog.setItems(rows());
    };
    const dialog: ListDialog = new ListDialog({
      title,
      intro,
      asking: true,
      footer: "space or 1-9 pick · enter send · or type your own · esc leave it",
      items: rows(),
      typeRow: { placeholder: "Type your own answer…", onSubmit: (v) => next(joinAskUserPicks(pickedLabels(), v)) },
      // Nothing picked yet: enter takes the highlighted one.
      onChoose: (choice) => next(picked.size ? joinAskUserPicks(pickedLabels()) : options[Number(choice.id)]!.label),
      actions: {
        " ": (row) => toggle(Number(row.id)),
        ...Object.fromEntries(options.slice(0, 9).map((_, k) => [String(k + 1), () => toggle(k)])),
      },
    });
    show(dialog);
  };
  ask(0);
}

// ─── MCP suggestion ──────────────────────────────────────────────────────────

/**
 * Atlarix suggests connecting an MCP server (the app shows a card for it):
 * Connect asks for what it needs, signs in, and tells the agent; Not now
 * tells it no.
 */
export async function openMcpSuggestion(ctx: ScreenContext): Promise<void> {
  const card = ctx.session.state.mcpSuggestions?.at(-1);
  if (!card) return;
  const mcp = ctx.services.mcp;
  const limit = await mcp.limit(ctx.session.appId).catch(() => null);
  const full = limit && limit.on >= limit.max ? limit : null;
  const finish = async (pollMs = 0): Promise<void> => {
    const deadline = Date.now() + pollMs;
    for (;;) {
      const r = await mcp.suggestFinish(card.id);
      if (r.connected) return void ctx.flash(`${r.server ?? card.title} is connected. Atlarix can use it now.`);
      if (Date.now() >= deadline) return void ctx.flash(r.reason ?? `${card.title} isn't connected yet.`, 6000, "warn");
      await new Promise((res) => setTimeout(res, 2000));
    }
  };
  const connect = async (values: Record<string, string>) => {
    const added = await mcp.suggestConnect(card.id, card.optionId, values);
    if (added.needsSignIn && added.where === "account") {
      const r = await mcp.accountSignIn(ctx.session.appId, String(added.id), (url) =>
        ctx.flash(`Sign in to ${card.title} in your browser: ${url}`),
      );
      if (!r.ok) return void ctx.flash(r.error ?? `Couldn't sign in to ${card.title}.`);
      return finish();
    }
    if (added.needsSignIn) {
      const s = await mcp.signIn(Number(added.id));
      if (!s.ok) return void ctx.flash(s.error ?? `Couldn't start ${card.title}'s sign-in.`);
      ctx.flash(`Sign in to ${card.title} in your browser.`);
      return finish(5 * 60_000);
    }
    if (added.needsSecret) {
      ctx.host.push(
        new InputDialog({
          title: card.title,
          label: added.needsSecret.header ?? "API key",
          mask: true,
          onSubmit: async (v) => {
            if (!v.trim()) return "Paste the key, or esc for not now.";
            if (added.where === "account") await mcp.accountSecret(ctx.session.appId, String(added.id), v.trim());
            else await mcp.setKey(Number(added.id), v.trim());
            ctx.host.pop();
            await finish();
          },
        }),
      );
      return;
    }
    return finish();
  };
  const ask = (i: number, values: Record<string, string>) => {
    const input = card.inputs[i];
    if (!input) return void connect(values).catch((e: Error) => ctx.flash(e.message));
    ctx.host.push(
      new InputDialog({
        title: card.title,
        label: input.required ? input.label : `${input.label} (optional)`,
        initial: input.default ?? "",
        mask: input.secret,
        onSubmit: (v) => {
          if (input.required && !v.trim()) return `${input.label} is needed.`;
          ctx.host.pop();
          ask(i + 1, v.trim() ? { ...values, [input.key]: v.trim() } : values);
        },
      }),
    );
  };
  ctx.host.push(
    new ListDialog({
      title: `Connect ${card.title}?`,
      intro: [
        { text: card.verified ? `${card.title} · ✓ Verified` : `${card.title} · ${card.publisher}`, bold: true },
        ...(card.reason ? [{ text: card.reason, tone: "muted" as const }] : []),
        // Said before Connect, not discovered after it (QA).
        ...(full ? [{ text: `${full.on} of ${full.max} are on: it will be added switched off.`, tone: "muted" as const }] : []),
      ],
      footer: "↑↓ move · enter choose · esc not now",
      items: [
        { id: "connect", label: "Connect" },
        { id: "no", label: "Not now" },
      ],
      onChoose: async (item) => {
        ctx.host.closeAll();
        if (item.id === "no") return void mcp.suggestDismiss(card.id);
        ask(0, {});
      },
    }),
  );
}

// ─── MCP tool consent ────────────────────────────────────────────────────────

/** An MCP tool call waiting for an OK, like the app's consent toast. */
export function openMcpConsent(ctx: ScreenContext): void {
  const req = ctx.session.state.mcpConsent;
  if (!req) return;
  ctx.host.push(
    new ListDialog({
      title: `Allow ${req.toolName}?`,
      intro: [
        { text: `Atlarix wants to call ${req.toolName} on ${req.serverName}.`, bold: true },
        ...(req.toolDescription ? [{ text: req.toolDescription.split("\n")[0]!, tone: "muted" as const }] : []),
        ...(req.inputPreview ? req.inputPreview.split("\n").slice(0, 6).map((text) => ({ text: `  ${text}`, tone: "muted" as const })) : []),
      ],
      footer: "↑↓ move · enter choose · esc no",
      items: [
        { id: "accept-once", label: "Yes" },
        { id: "accept-always", label: `Yes, always for ${req.toolName} on ${req.serverName}` },
        { id: "decline", label: "No" },
      ],
      onChoose: async (item) => {
        // Answer FIRST: a close with the request still pending is a refusal.
        const answered = ctx.session.answerMcpConsent(item.id as "accept-once" | "accept-always" | "decline");
        ctx.host.closeAll();
        await answered;
      },
    }),
  );
}

// ─── /automations ────────────────────────────────────────────────────────────

const PRESETS: Array<{ key: string; label: string; cron: string }> = [
  { key: "hourly", label: "Hourly", cron: "0 * * * *" },
  { key: "daily", label: "Daily (9am)", cron: "0 9 * * *" },
  { key: "weekly", label: "Weekly (Mon 9am)", cron: "0 9 * * 1" },
  { key: "weekday-mornings", label: "Weekday mornings", cron: "0 9 * * 1-5" },
];

export function describeTrigger(t: AutomationSummary["trigger"]): string {
  if (t.kind === "mcp") return `checks ${t.tool} every ${t.intervalMinutes} min`;
  const preset = PRESETS.find((p) => p.cron === t.cron);
  if (preset) return preset.label.toLowerCase();
  const clock = clockFromCron(t.cron);
  return clock ? `cron ${t.cron} (${formatClock(clock)})` : `cron ${t.cron}`;
}

const RUN_STATUS: Record<string, { text: string; tone: "accent" | "muted" | "error" | "warn" }> = {
  ok: { text: "✓", tone: "accent" },
  "nothing-to-report": { text: "–", tone: "muted" },
  error: { text: "✗", tone: "error" },
  running: { text: "…", tone: "muted" },
};

export function openAutomations(ctx: ScreenContext): void {
  let allFolders = false;
  const now = () => ctx.now?.() ?? new Date();
  const load = async (): Promise<ListItem[]> => {
    const [list, runs] = await Promise.all([
      ctx.services.automations.list(allFolders ? null : ctx.session.appId),
      ctx.services.automations.runs(ctx.session.appId).catch(() => []),
    ]);
    return list.map((a) => {
      const unread = runs.filter((r) => r.automationId === a.id && r.unread).length;
      return {
        id: a.id,
        label: a.name,
        badge: a.enabled ? (unread ? { text: `${unread} new`, tone: "accent" as const } : undefined) : { text: "off", tone: "muted" as const },
        // Short: the row is cut at the dialog's width ("last ran 2m ag", QA).
        detail: [describeTrigger(a.trigger), a.lastRunAt ? `ran ${ago(a.lastRunAt, now())}` : "not run yet"].join(" · "),
      };
    });
  };
  const find = async (id: string) =>
    (await ctx.services.automations.list(allFolders ? null : ctx.session.appId)).find((a) => a.id === id);
  let armedDelete: string | null = null;
  const dialog: ListDialog = new ListDialog({
    title: "Automations",
    intro: [{ text: "They run while Atlarix (the app, this CLI or an editor) is open.", tone: "muted" }],
    empty: "No automations for this folder. Press n to make one, or ask Atlarix to set one up.",
    footer: "enter runs · n new · e edit · space on/off · r run now · d delete · a all folders · esc",
    items: load,
    onChoose: (item) => openRuns(ctx, item.id, item.label),
    listActions: {
      n: () => openAutomationForm(ctx, null, () => void dialog.reload()),
      a: async () => {
        allFolders = !allFolders;
        await dialog.reload();
        return allFolders ? "Showing every folder's automations." : "Showing this folder's automations.";
      },
    },
    actions: {
      e: async (item) => {
        const a = await find(item.id);
        if (a) openAutomationForm(ctx, a, () => void dialog.reload());
      },
      " ": async (item) => {
        const a = await find(item.id);
        if (!a) return;
        await ctx.services.automations.toggle(a.id, !a.enabled);
        await dialog.reload();
        return a.enabled ? `“${a.name}” is off.` : `“${a.name}” is on.`;
      },
      r: async (item) => {
        await ctx.services.automations.runNow(item.id);
        return `Running “${item.label}” now. Its result shows here and in the transcript.`;
      },
      d: async (item) => {
        if (armedDelete !== item.id) {
          armedDelete = item.id;
          return `Press d again to delete “${item.label}”.`;
        }
        armedDelete = null;
        await ctx.services.automations.remove(item.id);
        await dialog.reload();
        return `Deleted “${item.label}”.`;
      },
    },
  });
  ctx.host.push(dialog);
  ctx.session.markAutomationsRead();
}

function openRuns(ctx: ScreenContext, automationId: string, name: string): void {
  const now = ctx.now?.() ?? new Date();
  ctx.host.push(
    new ListDialog({
      title: `${name} · runs`,
      empty: "It hasn't run yet. r on the list runs it now.",
      footer: "↑↓ move · enter details · esc back",
      items: async () => {
        const runs = (await ctx.services.automations.runs(ctx.session.appId)).filter((r) => r.automationId === automationId);
        void ctx.services.automations.markRead(runs.filter((r) => r.unread).map((r) => r.id));
        return runs.map((r) => ({
          id: r.id,
          // A summary is markdown: its first line without the backticks (QA).
          label: (r.summary ?? r.error ?? r.status).split("\n")[0]!.replace(/`/g, "").slice(0, 90),
          badge: RUN_STATUS[r.status],
          detail: ago(r.startedAt, now),
          keywords: JSON.stringify(r),
        }));
      },
      onChoose: (item) => {
        const r = JSON.parse(item.keywords!) as { summary: string | null; error: string | null; triggerContext: string | null; status: string };
        const lines: Line[] = [
          ...(r.summary ? r.summary.split("\n").map((text) => ({ text: text.replace(/`/g, "") })) : []),
          ...(r.error ? [{ text: r.error, tone: "error" as const }] : []),
          ...(r.triggerContext ? [{ text: "" }, { text: "What triggered it", tone: "muted" as const, bold: true }, ...r.triggerContext.split("\n").map((text) => ({ text, tone: "muted" as const }))] : []),
        ];
        ctx.host.push(new TextDialog({ title: item.label, lines: lines.length ? lines : [{ text: r.status, tone: "muted" }] }));
      },
    }),
  );
}

/**
 * New or edit, as a few short steps (each one dialog): name → when → what it
 * does → (the prompt) → who hears about it. The same fields as the app's form.
 */
export function openAutomationForm(ctx: ScreenContext, existing: AutomationSummary | null, done: () => void): void {
  const draft: AutomationDraft = existing
    ? { name: existing.name, enabled: existing.enabled, trigger: existing.trigger, prompt: existing.prompt, runMode: existing.runMode, notifyAgent: existing.notifyAgent, model: existing.model }
    : { name: "", enabled: true, trigger: { kind: "schedule", cron: "0 9 * * *", preset: "daily" }, prompt: "", runMode: "read-only", notifyAgent: false, model: null };
  const title = existing ? `Edit “${existing.name}”` : "New automation";
  const step = (d: ConstructorParameters<typeof ListDialog>[0] | null, input?: ConstructorParameters<typeof InputDialog>[0]) =>
    ctx.host.replace(d ? new ListDialog(d) : new InputDialog(input!));

  const save = async () => {
    try {
      if (existing) await ctx.services.automations.update(existing.id, draft);
      else await ctx.services.automations.create(ctx.session.appId, draft);
    } catch (e) {
      ctx.host.pop();
      ctx.flash(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    ctx.host.pop();
    done();
    ctx.flash(existing ? `Saved “${draft.name}”.` : `“${draft.name}” is set. It runs while Atlarix is open.`);
  };

  const notify = () =>
    step({
      title,
      intro: [{ text: "When it has something, who hears about it?", bold: true }],
      footer: "↑↓ move · enter choose · esc cancel",
      items: [
        { id: "user", label: "Just me", detail: "the run list and a line here; costs no tokens in chat" },
        { id: "agent", label: "Me and the agent", detail: "Atlarix wakes up with the result to act on it (tests, CI)" },
      ],
      onChoose: (i) => {
        draft.notifyAgent = i.id === "agent";
        void save();
      },
    });

  const prompt = () =>
    step(null, {
      title,
      intro: [{ text: "What should Atlarix do each time?", bold: true }, { text: "It runs read-only and reports back, e.g. “run the tests and tell me what fails”.", tone: "muted" }],
      label: "Instructions",
      initial: draft.prompt,
      onSubmit: (v) => {
        if (!v.trim()) return "Say what it should do.";
        draft.prompt = v.trim();
        notify();
      },
    });

  const what = () =>
    step({
      title,
      intro: [{ text: "When it fires, what happens?", bold: true }],
      footer: "↑↓ move · enter choose · esc cancel",
      items: [
        { id: "read-only", label: "Atlarix runs a task", detail: "read-only: it looks, runs checks, and reports" },
        { id: "notify-only", label: "Just tell me", detail: "no model, no tokens: what fired goes to the run list" },
      ],
      onChoose: (i) => {
        draft.runMode = i.id as AutomationDraft["runMode"];
        if (draft.runMode === "read-only") prompt();
        else notify();
      },
    });

  const cron = () =>
    step(null, {
      title,
      intro: [{ text: "A cron line: minute hour day month weekday.", tone: "muted" }, { text: "e.g. 30 8 * * 1-5 = weekdays at 8:30", tone: "muted" }],
      label: "Cron",
      initial: draft.trigger.kind === "schedule" ? draft.trigger.cron : "",
      onSubmit: (v) => {
        if (v.trim().split(/\s+/).length !== 5) return "Five fields: minute hour day month weekday.";
        draft.trigger = { kind: "schedule", cron: v.trim() };
        what();
      },
    });

  const mcpTrigger = async () => {
    const servers = await ctx.services.mcp.watchable(ctx.session.appId);
    if (!servers.length) {
      ctx.host.pop();
      ctx.flash("No MCP servers yet. /mcp adds one (b browses the marketplace), then try again.");
      return;
    }
    step({
      title,
      intro: [{ text: "Which MCP server does it check?", bold: true }],
      footer: "↑↓ move · enter choose · esc cancel",
      items: servers.map((s) => ({ id: s.ref, label: s.name, detail: s.detail })),
      onChoose: async (server) => {
        const tools = await ctx.services.mcp.watchTools(server.id);
        step({
          title,
          intro: [{ text: `Which ${server.label} tool? It is called on every check; a change in its answer fires the automation.`, bold: true }],
          searchable: true,
          footer: "type to search · enter choose · esc cancel",
          items: tools.map((t) => ({ id: t.name, label: t.name, detail: t.description?.split("\n")[0]?.slice(0, 70) })),
          onChoose: (tool) =>
            step(null, {
              title,
              label: "Check every (minutes, 5 or more)",
              initial: draft.trigger.kind === "mcp" ? String(draft.trigger.intervalMinutes) : "15",
              onSubmit: (v) => {
                const n = Number(v.trim());
                if (!Number.isInteger(n) || n < 5) return "A whole number of minutes, 5 or more.";
                draft.trigger = {
                  kind: "mcp",
                  ...(server.id.startsWith("account:")
                    ? { accountServer: server.id.slice("account:".length) }
                    : { serverId: Number(server.id.replace(/^local:/, "")) }),
                  tool: tool.id,
                  intervalMinutes: n,
                };
                what();
              },
            }),
        });
      },
    });
  };

  const when = () =>
    step({
      title,
      intro: [{ text: "When does it run?", bold: true }],
      footer: "↑↓ move · enter choose · esc cancel",
      items: [
        ...PRESETS.map((p) => ({ id: p.key, label: p.label, detail: p.cron })),
        { id: "cron", label: "Custom schedule…", detail: "a cron line" },
        { id: "mcp", label: "When something changes in an MCP server…", detail: "polls a tool" },
      ],
      onChoose: (i) => {
        const preset = PRESETS.find((p) => p.key === i.id);
        if (preset) {
          draft.trigger = { kind: "schedule", cron: preset.cron, preset: preset.key };
          what();
        } else if (i.id === "cron") cron();
        else void mcpTrigger();
      },
    });

  ctx.host.push(
    new InputDialog({
      title,
      label: "Name",
      initial: draft.name,
      onSubmit: (v) => {
        if (!v.trim()) return "Give it a name.";
        draft.name = v.trim().slice(0, 120);
        when();
      },
    }),
  );
}

// ─── /rename ─────────────────────────────────────────────────────────────────

/** `/rename <name>` names the session now; `/rename` alone asks, with the current name in the box. */
export async function openRename(ctx: ScreenContext, rest = ""): Promise<void> {
  const done = async (name: string) => {
    await ctx.session.rename(name);
    ctx.flash(`Renamed to “${name.trim()}”`, 2500, "success");
  };
  if (rest.trim()) {
    return done(rest).catch((e) => ctx.flash(e instanceof Error ? e.message : String(e), 4000, "error"));
  }
  ctx.host.push(
    new InputDialog({
      title: "Rename this session",
      label: "Name",
      initial: ctx.session.state.title ?? "",
      onSubmit: async (v) => {
        if (!v.trim()) return "Give it a name.";
        await done(v.slice(0, 120));
        ctx.host.closeAll();
      },
    }),
  );
}

// ─── /tasks ──────────────────────────────────────────────────────────────────

/** "1m 05s" / "42s". */
function age(ms: number): string {
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
}

/** Refresh `d` every `ms` while it is open; stops by itself once it is closed. */
function whileOpen(ctx: ScreenContext, d: Dialog, refresh: () => Promise<void>, ms = 1000): void {
  const t = setInterval(() => {
    if (!ctx.host.has(d)) return clearInterval(t);
    void refresh().catch(() => {});
  }, ms);
}

const TASK_TOOL_TONE: Record<string, Tone> = { running: "warn", success: "accent", error: "error", interrupted: "muted" };

/** A task's progress, as the app's card shows it: its tool calls, then its latest output. */
/** Lines of a command's output shown in its details. */
const DETAIL_OUTPUT_LINES = 15;

/**
 * One background task in full, the way Claude Code lays out "Shell details":
 * Status, Runtime, what it is, then its output (a command) or its tool calls
 * (a sub-agent). Re-read every second while open, so both are live.
 */
async function taskLines(ctx: ScreenContext, id: string): Promise<Line[]> {
  const t = (await ctx.session.liveTasks()).find((x) => x.id === id);
  if (!t) return [{ text: "Finished — its result is in the conversation.", tone: "muted" }];
  const lines: Line[] = [
    { text: `Status    ${t.stalled ? "gone quiet" : "running"}`, tone: t.stalled ? "warn" : "accent" },
    { text: `Runtime   ${age(t.elapsedMs)}`, tone: "text" },
    { text: `${t.kind === "command" ? "Command" : "Task   "}   ${t.label.split("\n")[0]}`, tone: "text", bold: true },
    { text: "" },
  ];
  if (t.kind === "agent") {
    lines.push({ text: t.tools.length ? `Tool calls (${t.tools.length})` : "Tool calls", tone: "muted", bold: true });
    for (const c of t.tools) {
      const icon = glyph.tool[c.status as keyof typeof glyph.tool] ?? glyph.tool.running;
      lines.push({ text: `  ${icon} ${c.verb} ${c.target.split("\n")[0]}`, tone: TASK_TOOL_TONE[c.status] === "error" ? "error" : "text" });
      if (c.summary) lines.push({ text: `      ${glyph.result} ${c.summary.split("\n")[0]}`, tone: "muted" });
    }
    if (!t.tools.length) lines.push({ text: "  None yet.", tone: "muted" });
    if (t.progress) lines.push({ text: "" }, { text: `Now   ${t.progress}`, tone: "muted" });
    return lines;
  }
  const output = (await ctx.session.taskOutput(t)).replace(/\s+$/, "");
  lines.push({ text: "Output", tone: "muted", bold: true });
  if (!output) return [...lines, { text: "  No output yet.", tone: "muted" }];
  const all = output.split("\n");
  for (const l of all.slice(-DETAIL_OUTPUT_LINES)) lines.push({ text: `  ${l}` });
  lines.push({
    text: all.length > DETAIL_OUTPUT_LINES ? `Showing the last ${DETAIL_OUTPUT_LINES} of ${all.length} lines` : `Showing ${all.length} line${all.length === 1 ? "" : "s"}`,
    tone: "muted",
  });
  return lines;
}

async function stopTaskById(ctx: ScreenContext, id: string): Promise<string> {
  const t = (await ctx.session.liveTasks()).find((x) => x.id === id);
  return t ? ctx.session.stopTask(t) : "It already finished.";
}

/**
 * One sub-agent's own transcript, live: what it was asked, each tool call and
 * what came back, then what it has written so far. ← → step to the other
 * sub-agents, esc backs out to the prompt box (Claude Code's agent view).
 */
export function openAgentView(ctx: ScreenContext, id: string): void {
  let current = id;
  const draw = async (top = false) => {
    const agents = (await ctx.session.liveTasks()).filter((t) => t.kind === "agent");
    const at = agents.findIndex((t) => t.id === current);
    const t = agents[at];
    if (!t) return view.setMarkdown("_Finished — its result is in the conversation._", "Sub-agent · finished", top);
    const head = [
      `Sub-agent ${at + 1}/${agents.length}`,
      t.label.split("\n")[0],
      `${t.stalled ? "quiet " : ""}${age(t.elapsedMs)}`,
      t.tokens ? `↓ ${formatTokens(t.tokens)} tokens` : null,
    ].filter(Boolean).join(" · ");
    const calls = t.tools.map((c) => {
      const icon = glyph.tool[c.status as keyof typeof glyph.tool] ?? glyph.tool.running;
      const target = c.target.split("\n")[0];
      return `- ${icon} **${c.verb}** ${target ? `\`${target.replace(/`/g, "'")}\`` : ""}${c.summary ? ` — ${c.summary.split("\n")[0]}` : ""}`;
    });
    const md = [
      calls.length ? calls.join("\n") : "_No tool calls yet._",
      t.text ? `---\n\n${t.text}` : t.progress ? `---\n\n_${t.progress}_` : "",
    ].filter(Boolean).join("\n\n");
    view.setMarkdown(md, head, top);
  };
  const view: TextDialog = new TextDialog({
    title: "Sub-agent",
    lines: [],
    markdown: "_Loading…_",
    hints: [
      { title: "agents", key: "←→" },
      { title: "stop", key: "x" },
      { title: "scroll", key: "↑↓" },
    ],
    actions: { x: () => stopTaskById(ctx, current) },
    step: (dir) => {
      void ctx.session.liveTasks().then((tasks) => {
        const agents = tasks.filter((t) => t.kind === "agent");
        const at = agents.findIndex((t) => t.id === current);
        if (agents.length < 2 || at < 0) return;
        current = agents[(at + dir + agents.length) % agents.length]!.id;
        void draw(true);
      });
    },
  });
  ctx.host.push(view);
  void draw(true);
  whileOpen(ctx, view, () => draw());
}

/** A background command's or sub-agent's details, live while open; x stops it. */
export function openTaskDetails(ctx: ScreenContext, id: string): void {
  if (id.startsWith("agent:") || id.startsWith("job:")) return openAgentView(ctx, id);
  const view: TextDialog = new TextDialog({
    title: "Command details",
    lines: () => taskLines(ctx, id),
    hints: [
      { title: "stop", key: "x" },
      { title: "scroll", key: "↑↓" },
    ],
    actions: { x: () => stopTaskById(ctx, id) },
  });
  ctx.host.push(view);
  whileOpen(ctx, view, async () => view.setLines(await taskLines(ctx, id)));
}

/**
 * What's still running (the app's sub-agent cards, as a list):
 * sub-agents and the commands the agent started in the background. ↑↓ picks
 * one; enter follows its progress live; k stops it. Opened by ↓ in an empty
 * prompt box while the border counts something running, or /tasks (/agents).
 */
export function openTasks(ctx: ScreenContext): void {
  const rows = async (): Promise<ListItem[]> => {
    const tasks = await ctx.session.liveTasks();
    const out: ListItem[] = [];
    const agents = tasks.filter((t) => t.kind === "agent");
    const commands = tasks.filter((t) => t.kind === "command");
    if (agents.length) out.push({ id: "h:agents", label: "Agents", header: true });
    for (const t of agents)
      out.push({
        id: t.id,
        label: t.label,
        badge: t.stalled ? { text: "quiet", tone: "warn" } : { text: age(t.elapsedMs), tone: "muted" },
        detail: t.tools.length ? `${t.tools.length} tool call${t.tools.length === 1 ? "" : "s"} · ${t.tools.at(-1)!.verb} ${t.tools.at(-1)!.target.split("\n")[0]}`.slice(0, 80) : t.progress?.slice(0, 80),
      });
    if (commands.length) out.push({ id: "h:cmds", label: "Commands", header: true });
    for (const t of commands)
      out.push({
        id: t.id,
        label: t.label.split("\n")[0]!.slice(0, 70),
        badge: t.stalled ? { text: "quiet", tone: "warn" } : { text: age(t.elapsedMs), tone: "muted" },
      });
    return out;
  };
  const stop = (id: string) => stopTaskById(ctx, id);
  const dialog: ListDialog = new ListDialog({
    title: "Background tasks",
    empty: "Nothing running in the background.",
    footer: "↑↓ choose · enter open · x stop · esc close",
    items: rows,
    onChoose: (item) => openTaskDetails(ctx, item.id),
    actions: {
      x: async (item) => {
        const said = await stop(item.id);
        await dialog.reload();
        return said;
      },
    },
  });
  ctx.host.push(dialog);
  whileOpen(ctx, dialog, () => dialog.reload(), 1500);
}

// ─── /btw ────────────────────────────────────────────────────────────────────

/**
 * A side question, answered over the conversation without joining it: the
 * turn in progress carries on, and neither the question nor the answer is
 * saved or seen by the agent (src/cli/agent/btw.ts).
 */
export function openAside(ctx: ScreenContext, question: string): void {
  if (!question.trim()) {
    ctx.host.push(
      new InputDialog({
        title: "By the way",
        intro: [{ text: "Ask about the conversation without interrupting it. Not saved, and Atlarix won't see it.", tone: "muted" }],
        label: "Question",
        footer: "enter ask · esc close",
        onSubmit: (v) => {
          if (!v.trim()) return "Type a question, or esc.";
          ctx.host.closeAll();
          openAside(ctx, v);
        },
      }),
    );
    return;
  }
  ctx.host.push(
    new TextDialog({
      title: "By the way",
      footer: "Not saved to the session · esc close",
      lines: async () => {
        try {
          const answer = await ctx.session.aside(question.trim());
          return [{ text: question.trim(), tone: "accent", bold: true }, { text: "" }, ...answer.split("\n").map((t) => ({ text: t }))];
        } catch (err) {
          return [{ text: `Couldn't answer: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }];
        }
      },
    }),
  );
}

// ─── /mcp ────────────────────────────────────────────────────────────────────

type AddedServerView = Awaited<ReturnType<ScreenContext["services"]["mcp"]["install"]>>;

/**
 * After an add: sign in, ask for a missing key, or say it worked. Each line
 * goes to `report` — the open /mcp list's own notice, where the user is
 * looking (the status line sat behind it, QA) — and `done(true)` when
 * something was added.
 */
async function finishMcpAdded(
  ctx: ScreenContext,
  added: AddedServerView[],
  done: (ok: boolean) => void,
  reportOne: (msg: string) => void,
): Promise<void> {
  // Every line stays: an import of two servers said only the last one (QA).
  const said: string[] = [];
  const report = (msg: string) => {
    said.push(msg);
    reportOne(said.join(" · "));
  };
  for (const a of added) {
    if (a.needsSignIn && a.where === "account") {
      const r = await ctx.services.mcp.accountSignIn(ctx.session.appId, String(a.id), (url) =>
        report(`Sign in to ${a.name} in your browser: ${url}`),
      );
      report(r.ok ? `${a.name} is ${r.enabled ? "on" : "signed in"}.` : (r.error ?? `Couldn't sign in to ${a.name}.`));
      continue;
    }
    if (a.needsSignIn) {
      const r = await ctx.services.mcp.signIn(Number(a.id));
      report(
        [a.note, r.ok ? `Sign in to ${a.name} in your browser.` : (r.error ?? `Couldn't start ${a.name}'s sign-in.`)]
          .filter(Boolean)
          .join(" "),
      );
      continue;
    }
    if (a.needsSecret && a.where === "account") {
      const id = String(a.id);
      ctx.host.push(
        new InputDialog({
          title: a.name,
          label: a.needsSecret.header ?? "API key",
          mask: true,
          onSubmit: async (v) => {
            if (!v.trim()) return "Paste the key, or esc to add it later.";
            await ctx.services.mcp.accountSecret(ctx.session.appId, id, v.trim());
            ctx.host.pop();
            report(`${a.name} added.`);
            done(true);
          },
        }),
      );
      return;
    }
    report(a.note ? `${a.name} added. ${a.note}` : `${a.name} added.`);
  }
  done(added.length > 0);
}

/** Add your own: a URL, a command, a config block, or the path of a config file. */
export function openMcpAdd(ctx: ScreenContext, done: (ok: boolean) => void, report: (msg: string) => void = ctx.flash): void {
  ctx.host.push(
    new InputDialog({
      title: "Add an MCP server",
      intro: [{ text: "A URL, a command, an mcpServers config, or the path of a config file.", tone: "muted" }],
      label: "Paste",
      footer: "enter adds · esc cancel",
      onSubmit: async (v) => {
        if (!v.trim()) return "Paste a URL, a command or a config.";
        const out = await ctx.services.mcp.paste(ctx.session.appId, v);
        if (out.added.length === 0) {
          return out.failed[0]?.error ?? (out.skipped[0] ? `Skipped ${out.skipped[0].name}: ${out.skipped[0].reason}.` : "Nothing was added.");
        }
        ctx.host.pop();
        const extra = [
          ...out.failed.map((f) => `${f.name}: ${f.error}`),
          ...out.skipped.map((x) => `Skipped ${x.name}: ${x.reason}.`),
        ];
        await finishMcpAdded(ctx, out.added, done, report);
        if (extra.length) report(extra.join(" · "));
      },
    }),
  );
}

/** Fill in what a marketplace server asks for, one value at a time, then add it. */
function installCatalogEntry(
  ctx: ScreenContext,
  entry: Awaited<ReturnType<ScreenContext["services"]["mcp"]["catalog"]>>["entries"][number],
  optionId: string,
  done: (ok: boolean) => void,
  report: (msg: string) => void,
): void {
  const option = entry.options.find((o) => o.id === optionId);
  if (!option) return;
  const values: Record<string, string> = {};
  const inputs = option.inputs;
  const add = async () => {
    const added = await ctx.services.mcp.install(ctx.session.appId, entry.name, optionId, values);
    await finishMcpAdded(ctx, [added], done, report);
  };
  const ask = (i: number) => {
    const input = inputs[i];
    if (!input) {
      void add().catch((e: Error) => report(e.message));
      return;
    }
    ctx.host.push(
      new InputDialog({
        title: entry.title,
        intro: input.description && input.description !== input.label ? [{ text: input.description, tone: "muted" }] : undefined,
        label: input.required ? input.label : `${input.label} (optional)`,
        initial: input.default ?? "",
        mask: input.secret,
        onSubmit: (v) => {
          if (input.required && !v.trim()) return `${input.label} is needed.`;
          if (v.trim()) values[input.key] = v.trim();
          ctx.host.pop();
          ask(i + 1);
        },
      }),
    );
  };
  ask(0);
}

/** The marketplace: search the registry (Verified first), enter adds; typing searches all of it. */
export function openMcpBrowse(ctx: ScreenContext, done: () => void, firstQuery = ""): void {
  type Entry = Awaited<ReturnType<ScreenContext["services"]["mcp"]["catalog"]>>["entries"][number];
  const entries = new Map<string, Entry>();
  const installed = new Set<string>();
  const rowsFor = async (query: string, offset = 0) => {
    const page = await ctx.services.mcp.catalog(ctx.session.appId, query.trim(), offset);
    // How much there is to browse: the whole registry, or what the search matched.
    const count = page.total.toLocaleString("en-US");
    list.retitle(`MCP marketplace · ${query.trim() ? `${count} ${page.total === 1 ? "match" : "matches"}` : `${count} ${page.total === 1 ? "server" : "servers"}`}`);
    for (const n of page.installed) installed.add(n);
    for (const e of page.entries) entries.set(e.name, e);
    return page.entries.map((e) => ({
      id: e.name,
      label: e.title,
      detail: `${e.verified ? "✓ Verified" : e.publisher} · ${e.kind === "web" ? "web" : "local"}${e.description ? ` · ${e.description}` : ""}`,
      right: installed.has(e.name) ? { text: "added", tone: "muted" as const } : undefined,
    }));
  };
  const list: ListDialog = new ListDialog({
    title: "MCP marketplace",
    wide: true,
    searchable: true,
    search: (q) => rowsFor(q),
    more: (q, have) => rowsFor(q, have),
    empty: "No servers match.",
    footer: "type to search the marketplace · enter adds · esc back",
    items: () => rowsFor(firstQuery),
    onChoose: (item) => {
      const entry = entries.get(item.id);
      if (!entry) return;
      if (installed.has(entry.name)) return void list.say(`${entry.title} is already added.`);
      const added = (ok: boolean) => {
        if (!ok) return;
        installed.add(entry.name);
        void list.reload();
        done();
      };
      const report = (msg: string) => list.say(msg);
      const usable = entry.options.filter((o) => o.kind === "web" || o.supported);
      if (usable.length <= 1) {
        if (usable[0]) installCatalogEntry(ctx, entry, usable[0].id, added, report);
        return;
      }
      ctx.host.push(
        new ListDialog({
          title: `${entry.title} · run it`,
          footer: "enter chooses · esc back",
          items: usable.map((o) => ({
            id: o.id,
            label: o.kind === "web" ? "On the web" : "On this computer",
            detail: o.kind === "web" ? o.url : `${o.registryType} · ${o.identifier}`,
          })),
          onChoose: (o) => {
            ctx.host.pop();
            installCatalogEntry(ctx, entry, o.id, added, report);
          },
        }),
      );
    },
  });
  ctx.host.push(list);
}

/**
 * /mcp: the servers this folder can use — the account's (every device and the
 * Chrome extension) and this computer's (shared with the app) — plus ones
 * found in other tools. space on/off, a adds, b browses the marketplace,
 * d deletes, t tests, enter lists tools (or signs in).
 */
export function openMcp(ctx: ScreenContext): void {
  let armed: string | null = null;
  // Each server is probed at most once per open dialog (a failing probe call can't loop).
  const probed = new Set<number>();
  let account: Awaited<ReturnType<typeof ctx.services.mcp.account>> = null;
  const dialog: ListDialog = new ListDialog({
    title: "MCP servers",
    wide: true,
    empty: "No MCP servers yet. b browses the marketplace, a adds your own.",
    hints: [
      { title: "On/off", key: "space" },
      { title: "Browse", key: "b" },
      { title: "Add", key: "a" },
      { title: "Delete", key: "d" },
      { title: "Test", key: "t" },
      { title: "Tools", key: "enter" },
    ],
    footer: "",
    items: async () => {
      account = await ctx.services.mcp.account().catch(() => null);
      const onAccount = (account ?? []).map((c) => {
        const needs =
          c.authType === "oauth" && !c.connected
            ? "sign in"
            : (c.authType === "api_key" || c.authType === "header") && !c.connected
              ? "needs key"
              : null;
        return {
          id: `acct:${c.id}`,
          label: c.name,
          detail: `all devices · ${(() => {
            try {
              return new URL(c.url).host;
            } catch {
              return c.url;
            }
          })()}`,
          right: needs
            ? { text: needs, tone: "muted" as const }
            : c.enabled
              ? { text: "✓ on", tone: "accent" as const }
              : { text: "○ off", tone: "muted" as const },
          keywords: needs ? "needs" : c.enabled ? "on" : "off",
        };
      });
      const servers = await ctx.services.mcp.list(ctx.session.appId);
      // Servers not yet tried in this process connect once in the background,
      // then the list shows how it went.
      const untried = servers.filter((s) => s.enabled && !s.needsSignIn && !s.connection && !probed.has(s.id)).map((s) => s.id);
      if (untried.length) {
        for (const id of untried) probed.add(id);
        // Never in the way of the list: a probe that throws (even before it
        // returns a promise) leaves the rows as they are.
        void Promise.resolve()
          .then(() => ctx.services.mcp.probe(untried))
          .then(() => dialog.reload())
          .catch(() => {});
      }
      const mine = servers.map((s) => ({
        id: String(s.id),
        label: s.name,
        detail: mcpServerDetail(s),
        right: mcpServerRight(s),
        keywords: s.needsSignIn ? "signin" : s.enabled ? "on" : "off",
      }));
      // The user's defaults not added here: enter opens the marketplace on one.
      const defaults = (await ctx.services.mcp.defaults(ctx.session.appId).catch(() => [])).filter((d) => d.state === "not-added");
      // Servers set up in other tools on this computer: enter adds one.
      let found: Awaited<ReturnType<typeof ctx.services.mcp.found>> = [];
      try {
        found = await ctx.services.mcp.found(ctx.session.appId);
      } catch {
        found = [];
      }
      return [
        ...onAccount,
        ...mine,
        ...defaults.map((d) => ({
          id: `default:${d.name}`,
          label: d.title,
          detail: "your default · not added here",
          right: { text: "enter adds", tone: "muted" as const },
          keywords: "default",
        })),
        ...found.map((f) => ({
          id: `found:${f.key}`,
          label: f.name,
          detail: `found in ${f.source}`,
          right: { text: "enter adds", tone: "muted" as const },
          keywords: "found",
        })),
      ];
    },
    onChoose: async (item) => {
      if (item.id.startsWith("default:")) return void openMcpBrowse(ctx, () => void dialog.reload(), item.label);
      if (item.id.startsWith("found:")) {
        await ctx.services.mcp.importFound(ctx.session.appId, item.id.slice("found:".length));
        await dialog.reload();
        return void dialog.say(`${item.label} added.`);
      }
      if (item.keywords === "signin") {
        const r = await ctx.services.mcp.signIn(Number(item.id));
        return void dialog.say(r.ok ? `Sign in to ${item.label} in your browser.` : (r.error ?? `Couldn't start ${item.label}'s sign-in.`));
      }
      if (item.id.startsWith("acct:")) {
        const c = account?.find((x) => `acct:${x.id}` === item.id);
        if (!c) return;
        if (item.keywords === "needs") {
          await finishMcpAdded(
            ctx,
            [
              {
                where: "account",
                id: c.id,
                name: c.name,
                enabled: c.enabled,
                needsSignIn: c.authType === "oauth",
                ...(c.authType !== "oauth" ? { needsSecret: { header: c.authHeader } } : {}),
              },
            ],
            () => void dialog.reload(),
            (m) => dialog.say(m),
          );
          return;
        }
        ctx.host.push(
          new TextDialog({
            title: `${c.name} · tools`,
            lines: async () =>
              c.tools.length
                ? c.tools.map((t) => ({ text: t, tone: "accent" as const }))
                : [{ text: "No tools listed yet: they appear after its first use.", tone: "muted" }],
          }),
        );
        return;
      }
      ctx.host.push(
        new TextDialog({
          title: `${item.label} · tools`,
          lines: async () => {
            const tools = await ctx.services.mcp.tools(Number(item.id));
            if (!tools.length) return [{ text: "No tools (or it couldn't be reached: t on the list tests it).", tone: "muted" }];
            return tools.flatMap((t) => [
              { text: t.name, tone: "accent" as const },
              ...(t.description ? [{ text: `  ${t.description.split("\n")[0]}`, tone: "muted" as const }] : []),
            ]);
          },
        }),
      );
    },
    actions: {
      " ": async (item) => {
        if (item.keywords === "found") return "Enter adds it first.";
        if (item.keywords === "needs") return "Enter finishes setting it up first.";
        const on = item.keywords !== "on";
        if (item.id.startsWith("acct:")) {
          await ctx.services.mcp.accountSetEnabled(ctx.session.appId, item.id.slice(5), on);
        } else {
          await ctx.services.mcp.setEnabled(Number(item.id), on);
        }
        await dialog.reload();
        return `${item.label} is ${on ? "on" : "off"}.`;
      },
      t: async (item) => {
        if (item.keywords === "found") return "Enter adds it first.";
        if (item.id.startsWith("acct:")) return `${item.label} runs through your account; it's tested when it's used.`;
        dialog.say(`Testing ${item.label}…`);
        const r = await ctx.services.mcp.test(Number(item.id));
        await dialog.reload();
        if (r.ok) return `${item.label} is working.`;
        if (r.needsOAuth) {
          const s = await ctx.services.mcp.signIn(Number(item.id));
          return s.ok ? `${item.label} needs you to sign in: finish it in your browser.` : `${item.label} needs a sign-in: ${s.error ?? "it couldn't start"}.`;
        }
        return `${item.label} failed: ${r.error ?? "unknown error"}`;
      },
      d: async (item) => {
        if (item.keywords === "found") return "Enter adds it first.";
        if (armed !== item.id) {
          armed = item.id;
          return item.id.startsWith("acct:")
            ? `d again removes ${item.label} from your account (every device).`
            : `d again deletes ${item.label} (here and in the app).`;
        }
        armed = null;
        if (item.id.startsWith("acct:")) await ctx.services.mcp.accountRemove(item.id.slice(5));
        else await ctx.services.mcp.remove(Number(item.id));
        await dialog.reload();
        return `Deleted ${item.label}.`;
      },
    },
    listActions: {
      a: () => openMcpAdd(ctx, () => void dialog.reload(), (m) => dialog.say(m)),
      b: () => openMcpBrowse(ctx, () => void dialog.reload()),
    },
  });
  ctx.host.push(dialog);
}

// ─── /permissions ────────────────────────────────────────────────────────────

export function openPermissions(ctx: ScreenContext): void {
  let perms: SavedPermission[] = [];
  let armed: string | null = null;
  const dialog: ListDialog = new ListDialog({
    title: "Saved permissions",
    intro: [{ text: "What you've allowed Atlarix to do in this folder without asking.", tone: "muted" }],
    empty: "Nothing saved. Choosing “Yes, always …” on an approval adds it here.",
    footer: "↑↓ move · d remove · esc close",
    items: async () => {
      perms = await ctx.services.permissions.list(ctx.session.appId);
      return perms.map((p, i) => ({
        id: String(i),
        label: p.label,
        badge: { text: p.kind === "command" ? "command" : "file", tone: "muted" as const },
        detail: p.decision,
      }));
    },
    actions: {
      d: async (item) => {
        if (armed !== item.id) {
          armed = item.id;
          return `Press d again to remove “${item.label}”: Atlarix will ask again.`;
        }
        armed = null;
        await ctx.services.permissions.revoke(ctx.session.appId, perms[Number(item.id)]!);
        await dialog.reload();
        return `Removed. Atlarix asks before “${item.label}” again.`;
      },
    },
  });
  ctx.host.push(dialog);
}

// ─── /connect ────────────────────────────────────────────────────────────────

/** Shown first in /connect (opencode's "Popular"); the rest follow by name. */
const POPULAR_PROVIDERS = ["openai", "anthropic", "google", "openrouter", "deepseek", "xai"];
const CHROME_ROW = "__chrome";
const MCP_ROW = "__mcp";
const CUSTOM_ROW = "__custom";

/** The Chrome extension is talking to Atlarix (from the bridge status line). */
export function chromeConnected(status: string): boolean {
  return !/^(not connected|unavailable)/.test(status);
}

/**
 * /connect: everything Atlarix can be connected to, in one list (opencode's
 * "Connect a provider", plus the tools): a provider's API key, the Chrome
 * extension, an MCP server. ✓ marks what is already connected. A provider's
 * key leads back to /model with that provider's models (`onSaved`).
 */
export function openConnect(ctx: ScreenContext, onSaved: (providerId?: string) => void): void {
  ctx.host.push(
    new ListDialog({
      title: "Connect",
      searchable: true,
      wide: true,
      footer: "type to search · enter connect · esc close",
      items: async () => {
        const providers = await ctx.services.providers.list();
        // How many models each offers (the catalog), as the editor shows: you
        // see what a provider has before you give it a key (owner).
        const counts = new Map<string, number>();
        await import("@/lib/models_dev")
          .then(async ({ catalogModelCount }) => {
            for (const p of providers) if (!p.custom) counts.set(p.id, await catalogModelCount(p.id));
          })
          .catch(() => {});
        const row = (p: (typeof providers)[number]) => {
          const n = counts.get(p.id) ?? 0;
          return {
            id: p.id,
            label: p.name,
            keywords: p.id,
            gutter: p.hasKey ? { text: "✓", tone: "accent" as const } : undefined,
            right: p.hasKey ? { text: "key saved", tone: "muted" as const } : n ? { text: `${n} model${n === 1 ? "" : "s"}`, tone: "muted" as const } : undefined,
          };
        };
        const popular = POPULAR_PROVIDERS.map((id) => providers.find((p) => p.id === id)).filter((p): p is (typeof providers)[number] => !!p);
        const rest = providers.filter((p) => !POPULAR_PROVIDERS.includes(p.id));
        const chrome = ctx.chromeStatus();
        return [
          { id: "h:popular", label: "Popular", header: true },
          ...popular.map(row),
          { id: "h:tools", label: "Tools", header: true },
          {
            id: CHROME_ROW,
            label: "Chrome extension",
            keywords: "browser chrome edge brave extension",
            gutter: chromeConnected(chrome) ? { text: "✓", tone: "accent" as const } : undefined,
            right: { text: chromeConnected(chrome) ? chrome.split(" (")[0]! : "not connected", tone: "muted" as const },
          },
          { id: MCP_ROW, label: "MCP server…", keywords: "mcp tools server", right: { text: "/mcp", tone: "muted" as const } },
          { id: "h:providers", label: "Providers", header: true },
          // Anything not on the list: a gateway, a proxy, a server on this computer.
          {
            id: CUSTOM_ROW,
            label: "Other: your own endpoint…",
            keywords: "other custom openai anthropic compatible messages bedrock gateway proxy local vllm llama.cpp lm studio litellm endpoint base url",
            right: { text: "base URL + key", tone: "muted" as const },
          },
          ...rest.map(row),
        ];
      },
      onChoose: async (item) => {
        if (item.id === CHROME_ROW) return openChrome(ctx);
        if (item.id === MCP_ROW) return openMcpAdd(ctx, () => openMcp(ctx));
        if (item.id === CUSTOM_ROW) return openCustomProvider(ctx, onSaved);
        const p = (await ctx.services.providers.list()).find((x) => x.id === item.id);
        // A key already saved: replace it, or remove it (owner: users sometimes
        // want it gone, not replaced). Removing asks twice.
        if (p?.hasKey) {
          const keyless = p.keyHint === "none";
          ctx.host.push(
            new ListDialog({
              title: item.label,
              intro: [{ text: p.keyHint === "none" ? `${item.label} needs no key.` : `Your ${item.label} key is saved${p.keyHint ? ` (${p.keyHint})` : ""}.`, tone: "muted" }],
              footer: "↑↓ move · enter choose · esc back",
              // No key to replace on a keyless provider: removing it is the
              // one thing to do (QA: "needs no key", then "Replace the key").
              items: [
                ...(keyless ? [] : [{ id: "replace", label: "Replace the key" }]),
                // A provider you added goes with its key (its models too): say so (QA).
                { id: "remove", label: keyless || p.custom ? `Remove ${item.label}` : "Remove the key", detail: "chats on its models move to Atlarix Auto" },
              ],
              onChoose: (choice) => {
                if (choice.id === "replace") return askKey();
                ctx.host.push(
                  new ListDialog({
                    // A provider you added goes with its key, as the editor says (QA).
                    title: keyless ? `Remove ${item.label}?` : p.custom ? `Remove ${item.label} and its key?` : `Remove your ${item.label} key?`,
                    intro: [{ text: "It's deleted from this computer, for the Atlarix app and the editor too.", tone: "muted" }],
                    footer: "↑↓ move · enter choose · esc back",
                    items: [
                      { id: "keep", label: "Keep it" },
                      { id: "remove", label: "Remove it" },
                    ],
                    onChoose: async (c) => {
                      if (c.id === "keep") return ctx.host.pop();
                      await ctx.services.providers.removeKey(item.id);
                      ctx.host.closeAll();
                      ctx.flash(`Removed ${keyless ? item.label : `the ${item.label} key`}. Chats on its models move to Atlarix Auto.`, 4000, "success");
                    },
                  }),
                );
              },
            }),
          );
          return;
        }
        askKey();
        function askKey() {
        ctx.host.push(
          new InputDialog({
            title: `${item.label} API key`,
            intro: [
              { text: "Saved encrypted on this computer and shared with the Atlarix app.", tone: "muted" },
              ...(p?.keyUrl ? [{ text: `Get one at ${p.keyUrl}`, tone: "muted" as const }] : []),
            ],
            label: "Paste the key",
            mask: true,
            onSubmit: async (v) => {
              if (v.trim().length < 8) return "That doesn't look like a key.";
              try {
                await ctx.services.providers.saveKey(item.id, v);
              } catch (e) {
                return e instanceof Error ? e.message : String(e);
              }
              ctx.host.closeAll();
              ctx.flash(`${item.label} connected.`);
              onSaved(item.id);
            },
          }),
        );
        }
      },
    }),
  );
}

/**
 * A provider that isn't on the list: any endpoint on the OpenAI or the
 * Anthropic format. Format, name, base URL, key (none for most servers on this computer); its models come from
 * the endpoint, else it asks for one model id. Shared with the app and the
 * editor, like every provider.
 */
export function openCustomProvider(ctx: ScreenContext, onSaved: (providerId?: string) => void): void {
  let title = "Your own endpoint";
  const draft: { name: string; baseUrl: string; key: string; apiFormat: "openai" | "anthropic" } = {
    name: "",
    baseUrl: "",
    key: "",
    apiFormat: "openai",
  };
  const save = async (models?: string[]): Promise<string | undefined> => {
    try {
      const r = await ctx.services.providers.addCustom({ ...draft, models });
      ctx.host.closeAll();
      ctx.flash(`${draft.name} connected · ${r.models} model${r.models === 1 ? "" : "s"}.`, 4000, "success");
      onSaved(r.id);
      return undefined;
    } catch (e) {
      if (e instanceof Error && e.name === "NoModelsListedError" && !models) {
        ctx.host.replace(
          new InputDialog({
            title,
            intro: [{ text: "The endpoint didn't list its models.", bold: true }, {
                text:
                  draft.apiFormat === "anthropic"
                    ? "Type the id of the model to use, e.g. us.anthropic.claude-haiku-4-5-20251001-v1:0 or claude-haiku-4-5."
                    : "Type the id of the model to use, e.g. qwen2.5:7b or gpt-4o-mini.",
                tone: "muted",
              }],
            label: "Model id",
            onSubmit: (v) => (v.trim() ? save([v.trim()]) : "Type a model id."),
          }),
        );
        return undefined;
      }
      return e instanceof Error ? e.message : String(e);
    }
  };
  const keyStep = () =>
    ctx.host.replace(
      new InputDialog({
        title,
        intro: [
          { text: "Saved encrypted on this computer and shared with the Atlarix app.", tone: "muted" },
          { text: "Leave it empty for a server that needs none (most on this computer).", tone: "muted" },
        ],
        label: "API key",
        mask: true,
        onSubmit: (v) => {
          draft.key = v.trim();
          return save();
        },
      }),
    );
  const urlStep = () =>
    ctx.host.replace(
      new InputDialog({
        title,
        intro: [
          {
            text:
              draft.apiFormat === "anthropic"
                ? "Up to /v1, e.g. https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1"
                : "Up to /v1, e.g. https://api.example.com/v1 or http://localhost:1234/v1",
            tone: "muted",
          },
        ],
        label: "Base URL",
        footer: "enter next · esc cancel",
        onSubmit: (v) => {
          const url = v.trim();
          if (!/^https?:\/\/\S+$/i.test(url)) return "A URL starting with https:// (or http:// for one on this computer).";
          draft.baseUrl = url;
          keyStep();
        },
      }),
    );
  const nameStep = () =>
    ctx.host.replace(
      new InputDialog({
        title,
        intro: [
          {
            text:
              draft.apiFormat === "anthropic"
                ? "Any provider that speaks the Anthropic Messages API: Bedrock, a gateway, a proxy."
                : "Any provider that speaks the OpenAI API: a gateway, a proxy, a server on this computer.",
            tone: "muted",
          },
        ],
        label: "Name",
        footer: "enter next · esc cancel",
        onSubmit: (v) => {
          if (!v.trim()) return "Give it a name.";
          draft.name = v.trim().slice(0, 60);
          urlStep();
        },
      }),
    );
  ctx.host.push(
    new ListDialog({
      title,
      intro: [{ text: "Which API does it speak?", tone: "muted" }],
      footer: "↑↓ move · enter choose · esc close",
      items: [
        { id: "openai", label: "OpenAI-compatible", right: { text: "/chat/completions", tone: "muted" } },
        { id: "anthropic", label: "Anthropic", right: { text: "/messages", tone: "muted" } },
      ],
      onChoose: (item) => {
        draft.apiFormat = item.id === "anthropic" ? "anthropic" : "openai";
        title = draft.apiFormat === "anthropic" ? "Anthropic-format endpoint" : "OpenAI-compatible endpoint";
        nameStep();
      },
    }),
  );
}

// ─── /chrome ─────────────────────────────────────────────────────────────────

/** The Chrome extension: whether it is connected, and how to connect it. */
export function openChrome(ctx: ScreenContext): void {
  const STORE = "https://chromewebstore.google.com/detail/fkoacefbjjjhjceidagdajkgclfjacbe";
  const lines = (): Line[] => {
    const status = ctx.chromeStatus();
    if (chromeConnected(status)) {
      return [
        { text: `✓ Connected · ${status}`, tone: "accent", bold: true },
        { text: "" },
        { text: "Atlarix drives your own Chrome, Edge or Brave in its own tab group, and searches the web through it.", tone: "muted" },
      ];
    }
    return [
      { text: status.startsWith("unavailable") ? "This build has no browser bridge." : "Not connected", tone: "warn", bold: true },
      { text: "" },
      { text: "1. Install the free Atlarix extension in Chrome, Edge or Brave (o opens the store)." },
      { text: "2. Click its icon in the toolbar to wake it; it connects to whichever Atlarix is open." },
      { text: "3. r checks again." },
      { text: "" },
      { text: "With it, Atlarix can test your app in your browser and search the web. Without it, add a search MCP (/mcp).", tone: "muted" },
    ];
  };
  const dialog: TextDialog = new TextDialog({
    title: "Chrome extension",
    lines: lines(),
    hints: [
      { title: "Open the store", key: "o" },
      { title: "Check again", key: "r" },
    ],
    actions: {
      o: () => {
        if (!ctx.open) return `Open ${STORE}`;
        ctx.open(STORE);
        return "Opening the Chrome Web Store…";
      },
      r: () => {
        dialog.setLines(lines());
        return chromeConnected(ctx.chromeStatus()) ? "Connected." : "Still not connected.";
      },
    },
  });
  ctx.host.push(dialog);
}

// ─── /billing ────────────────────────────────────────────────────────────────

/**
 * /billing (and /upgrade): Pro, or credit you pay as you go (the app's
 * Settings → Billing). Checkout is Lemon Squeezy's page in the browser; the
 * link is shown too, for a session over SSH.
 */
export function openBilling(ctx: ScreenContext): void {
  const go = async (kind: "pro" | "credit", cents?: number) => {
    if (!(await ctx.services.account.email())) return "Sign in first: /login.";
    ctx.flash("Opening checkout…");
    const url = await ctx.services.account.checkout(kind, cents);
    if (!url) return "Couldn't open checkout. Try again in a moment.";
    ctx.open?.(url);
    ctx.host.replace(
      new TextDialog({
        title: kind === "pro" ? "Get Atlarix Pro" : `Add ${formatCents(cents ?? 0)} credit`,
        lines: [
          { text: "Checkout is open in your browser. Your balance updates here once it's paid.", tone: "accent" },
          { text: "" },
          { text: "If it didn't open:", tone: "muted" },
          { text: url },
        ],
        hints: [{ title: "Copy the link", key: "c" }],
        actions: { c: async () => ((await ctx.copy?.(url)) ? "Copied." : url) },
      }),
    );
  };
  ctx.host.push(
    new ListDialog({
      title: "Plans and credit",
      wide: true,
      intro: [
        { text: CORE_PAYMENT_SUMMARY, tone: "muted" },
      ],
      footer: "↑↓ move · enter choose · esc close",
      items: async () => {
        const [email, cents] = await Promise.all([ctx.services.account.email(), ctx.services.account.balanceCents().catch(() => null)]);
        return [
          { id: "h:you", label: email ? `Signed in as ${email}` : "Not signed in: /login first", header: true },
          ...(cents != null ? [{ id: "balance", label: "Core credit", right: { text: formatCents(cents), tone: "accent" as const } }] : []),
          { id: "h:pro", label: "Pro", header: true },
          { id: "pro", label: "Get Atlarix Pro", detail: "$19/month, Core included across the app, extension and Reviewer" },
          { id: "h:credit", label: "Pay as you go", header: true },
          { id: "c1000", label: "Add $10 credit" },
          { id: "c2500", label: "Add $25 credit" },
          { id: "c5000", label: "Add $50 credit" },
          { id: "custom", label: "Another amount…" },
          { id: "h:manage", label: "Your subscription", header: true },
          { id: "manage", label: "Manage or cancel it", detail: "Lemon Squeezy orders page" },
        ];
      },
      onChoose: async (item) => {
        if (item.id === "balance") return;
        if (item.id === "pro") return void (await go("pro").then((said) => said && ctx.flash(said)));
        if (item.id.startsWith("c")) return void (await go("credit", Number(item.id.slice(1))).then((said) => said && ctx.flash(said)));
        if (item.id === "manage") {
          ctx.open?.("https://app.lemonsqueezy.com/my-orders");
          return ctx.flash("Opening your Lemon Squeezy orders…");
        }
        if (item.id === "custom") {
          ctx.host.push(
            new InputDialog({
              title: "Add credit",
              intro: [{ text: "In dollars, $10 or more.", tone: "muted" }],
              label: "Amount",
              onSubmit: async (v) => {
                const dollars = Number(v.replace(/[$,\s]/g, ""));
                if (!Number.isFinite(dollars) || dollars < 10) return "$10 or more.";
                const said = await go("credit", Math.round(dollars * 100));
                return said ?? undefined;
              },
            }),
          );
        }
      },
    }),
  );
}

// ─── /analytics ──────────────────────────────────────────────────────────────

/**
 * "Help improve Atlarix": the app's usage-analytics question, same words
 * (AnalyticsConsentModal.tsx; the two must not drift) and the same setting, so
 * one answer covers the app and the terminal. Asked once, on the first run that
 * finds it unanswered; `/analytics` changes it any time after.
 */
export function openAnalytics(ctx: ScreenContext, firstRun = false): void {
  void ctx.services.analytics.consent().then((now) => {
    const choose = async (v: "opted_in" | "opted_out") => {
      await ctx.services.analytics.setConsent(v);
      ctx.host.closeAll();
      ctx.flash(v === "opted_in" ? "Thanks: usage analytics are on. /analytics turns them off." : "Usage analytics are off. /analytics turns them on.", 3500, v === "opted_in" ? "success" : "info");
    };
    ctx.host.push(
      new ListDialog({
        title: "Help improve Atlarix",
        intro: [
          { text: "Share usage data — which features get used and whether they work." },
          { text: "Never your code, prompts or files. Anonymous when signed out. Signed in, it's tied to your account (email and name) and includes your rough location from your connection, never the address itself. Change it anytime in /analytics." },
          { text: "Not covered by this choice: crash reports (stack traces and device info), and for signed-in accounts a daily count of turns by surface, provider type, model and token size. Never prompts, code or keys.", tone: "muted" },
          { text: "The same setting as the Atlarix app: one answer covers both.", tone: "muted" },
        ],
        footer: firstRun ? "↑↓ move · enter choose · /analytics changes it later" : "↑↓ move · enter choose · esc close",
        initialId: now === "opted_out" ? "no" : "yes",
        items: [
          { id: "yes", label: "Yes, that's fine", gutter: now === "opted_in" ? { text: "●", tone: "accent" } : undefined },
          { id: "no", label: "No thanks", gutter: now === "opted_out" ? { text: "●", tone: "accent" } : undefined },
        ],
        onChoose: (item) => void choose(item.id === "yes" ? "opted_in" : "opted_out"),
      }),
    );
  });
}

// ─── /login, /logout ─────────────────────────────────────────────────────────

export async function openLogin(ctx: ScreenContext): Promise<void> {
  const email = await ctx.services.account.email();
  if (email) {
    ctx.flash(`Signed in as ${email}. /logout to switch accounts.`);
    return;
  }
  const dialog = new TextDialog({ title: "Sign in", lines: [{ text: "Starting…", tone: "muted" }] });
  ctx.host.push(dialog);
  try {
    const who = await ctx.signIn((lines) => dialog.setLines(lines));
    ctx.host.closeAll();
    ctx.flash(`Signed in as ${who}.`);
  } catch (e) {
    dialog.setLines([{ text: e instanceof Error ? e.message : String(e), tone: "error" }]);
  }
}

export function openLogout(ctx: ScreenContext): void {
  ctx.host.push(
    new ListDialog({
      title: "Sign out of the CLI?",
      intro: [{ text: "The Atlarix app and the extension stay signed in.", tone: "muted" }],
      footer: "enter choose · esc cancel",
      items: [
        { id: "yes", label: "Sign out" },
        { id: "no", label: "Cancel" },
      ],
      onChoose: async (item) => {
        ctx.host.closeAll();
        if (item.id !== "yes") return;
        await ctx.services.account.signOut();
        ctx.flash("Signed out. /login signs in again.");
      },
    }),
  );
}

// ─── /relics ─────────────────────────────────────────────────────────────────

export function openRelics(ctx: ScreenContext): void {
  const now = ctx.now?.() ?? new Date();
  let relics: Awaited<ReturnType<CliServices["relics"]["list"]>> = [];
  let armed: string | null = null;
  const find = (id: string) => relics.find((r) => r.id === id);
  const dialog: ListDialog = new ListDialog({
    title: "Relics",
    intro: [{ text: "Pages Atlarix made to share. Hosted ones are private until you share them.", tone: "muted" }],
    empty: "No relics yet. Ask Atlarix for a design, an explainer or a report as a relic.",
    footer: "enter open · c copy link · s share · d delete · esc close",
    items: async () => {
      relics = await ctx.services.relics.list(ctx.session.workspaceDir);
      return relics.map((r) => ({
        id: r.id,
        label: r.title,
        badge: r.hosted
          ? { text: r.visibility === "link" ? "shared" : "private", tone: r.visibility === "link" ? ("accent" as const) : ("muted" as const) }
          : { text: "local", tone: "muted" as const },
        detail: [ago(r.updatedAt, now), r.url ?? (r.path ? r.path.replace(ctx.session.workspaceDir + "/", "") : "")].join(" · "),
      }));
    },
    onChoose: (item) => {
      const r = find(item.id);
      if (r) ctx.open?.(r.url ?? r.path!);
    },
    actions: {
      c: async (item) => {
        const r = find(item.id);
        if (!r) return;
        const text = r.url ?? r.path!;
        return (await ctx.copy?.(text)) ? `Copied ${text}` : text;
      },
      s: async (item) => {
        const r = find(item.id);
        if (!r?.hosted) return "A local relic is a file: send the folder to share it.";
        const next = r.visibility === "link" ? "private" : "link";
        await ctx.services.relics.setVisibility(r.id, next);
        await dialog.reload();
        return next === "link" ? "Anyone with the link can view it now." : "Only you can view it now.";
      },
      d: async (item) => {
        const r = find(item.id);
        if (!r) return;
        if (armed !== r.id) {
          armed = r.id;
          return `Press d again to delete “${r.title}”${r.hosted ? " (its link stops working)" : ""}.`;
        }
        armed = null;
        await ctx.services.relics.remove(r, ctx.session.workspaceDir);
        await dialog.reload();
        return `Deleted “${r.title}”.`;
      },
    },
  });
  ctx.host.push(dialog);
}

// ─── /status ─────────────────────────────────────────────────────────────────

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function statusLines(ctx: ScreenContext): Promise<Line[]> {
  const s = ctx.session.state;
  const [email, balance, mcp, automations] = await Promise.all([
    ctx.services.account.email().catch(() => null),
    ctx.services.account.balanceCents().catch(() => null),
    ctx.services.mcp.list(ctx.session.appId).catch(() => []),
    ctx.services.automations.list(ctx.session.appId).catch(() => []),
  ]);
  const row = (k: string, v: string, tone?: Line["tone"]): Line => ({ text: `${k.padEnd(13)}${v}`, tone });
  const tokens = s.sessionTokens
    ? `${s.sessionTokens.toLocaleString()} tokens${s.cachedTokens ? ` (${s.cachedTokens.toLocaleString()} from cache)` : ""}`
    : "nothing yet";
  return [
    row("Version", ctx.version),
    row("Account", email ?? "signed out (/login)", email ? undefined : "warn"),
    ...(email ? [row("Balance", balance == null ? "unknown" : money(balance))] : []),
    row("Model", ctx.modelLabel()),
    row("Mode", s.mode),
    row("Folder", ctx.session.workspaceDir.replace(os.homedir(), "~")),
    { text: "" },
    row("This session", tokens),
    ...(s.costUsd > 0 ? [row("Cost", `$${s.costUsd.toFixed(4)} on your own keys`)] : []),
    ...(s.contextPercent != null ? [row("Context", `${s.contextPercent}% full`)] : []),
    { text: "" },
    row("Chrome", ctx.chromeStatus()),
    row("MCP", mcp.length ? `${mcp.length} server${mcp.length === 1 ? "" : "s"} (/mcp)` : "none in this folder"),
    row(
      "Automations",
      automations.length
        ? `${automations.filter((a) => a.enabled).length} on, ${automations.filter((a) => !a.enabled).length} off · run while Atlarix is open`
        : "none in this folder (/automations)",
    ),
  ];
}

export function openStatus(ctx: ScreenContext): void {
  ctx.host.push(new TextDialog({ title: "Status", lines: () => statusLines(ctx) }));
}

// ─── /usage ──────────────────────────────────────────────────────────────────

/** The overview tab: your activity on this computer (lib/stats/activity-format). */
export function statsLines(s: import("@/lib/stats/usage-stats").ActivityStats): Line[] {
  if (!s.since) return [{ text: "No activity yet.", tone: "muted" }];
  const tiles = activityTiles(s);
  const width = 16;
  const lines: Line[] = [
    { text: tiles.map((t) => t.value.padEnd(width)).join("").trimEnd(), bold: true },
    { text: tiles.map((t) => t.label.padEnd(width)).join("").trimEnd(), tone: "muted" },
    { text: "" },
    { text: "Activity · last 12 months", bold: true },
    ...calendarRows(s).map((text, i, all) => ({ text, tone: i === 0 || i === all.length - 1 ? ("muted" as const) : ("accent" as const) })),
  ];
  for (const section of activitySections(s)) {
    lines.push({ text: "" }, { text: section.title, bold: true });
    for (const r of section.rows) lines.push({ text: `  ${r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label.padEnd(34)}  ${r.value}` });
  }
  lines.push({ text: "" }, { text: activityFootnote(s), tone: "muted" });
  return lines;
}

type UsageState = {
  tab: UsageTab;
  filters: import("@/lib/stats/usage-report").UsageFilters;
  report: import("@/lib/stats/usage-report").UsageReport | null;
  credits: import("@/lib/billing/usage-credits").UsageCredits | null;
};

/** The next value of a filter: all, then each option in turn. */
function cycleFilter(current: string | undefined, options: ReadonlyArray<{ key: string }>): string | undefined {
  const keys = options.map((o) => o.key);
  const at = current ? keys.indexOf(current) : -1;
  return at + 1 < keys.length ? keys[at + 1] : undefined;
}

/** One tab of /usage as lines: the tab bar, then the tab. */
export function usageLines(st: UsageState): Line[] {
  const bar = USAGE_TABS.map((t) => (t.key === st.tab ? `[${t.label}]` : t.label)).join("  ");
  const head: Line[] = [{ text: bar, bold: true }, { text: "" }];
  if (st.tab === "credits") return [...head, ...creditsText(st.credits)];
  const r = st.report;
  if (!r) return [...head, { text: "Loading…", tone: "muted" }];
  if (st.tab === "overview") return [...head, ...statsLines(r.overview)];
  if (st.tab === "tokens") return [...head, ...tokensText(r)];
  if (st.tab === "tools") return [...head, ...toolsText(r)];
  return [...head, ...autoText(r)];
}

export function openUsage(ctx: ScreenContext): void {
  const st: UsageState = { tab: "overview", filters: {}, report: null, credits: null };
  const draw = (top = false) => view.setLines(usageLines(st), top);
  const load = async () => {
    st.report = await ctx.services.usage(st.filters);
    draw();
  };
  const filter = (key: "model" | "surface" | "source") => () => {
    if (!st.report) return;
    const options = key === "model" ? st.report.filters.models : key === "surface" ? st.report.filters.surfaces : st.report.filters.sources;
    st.filters = { ...st.filters, [key]: cycleFilter(st.filters[key], options) };
    st.tab = "tokens";
    return load().then(() => undefined);
  };
  const view: TextDialog = new TextDialog({
    title: "Usage",
    wide: true,
    lines: [{ text: "Loading…", tone: "muted" }],
    hints: [
      { title: "tabs", key: "←→" },
      { title: "model", key: "m" },
      { title: "surface", key: "s" },
      { title: "source", key: "o" },
      { title: "range", key: "r" },
      { title: "share card", key: "c" },
    ],
    actions: {
      m: filter("model"),
      s: filter("surface"),
      o: filter("source"),
      r: () => {
        const ranges = USAGE_RANGES as readonly number[];
        st.filters = { ...st.filters, days: ranges[(ranges.indexOf(st.report?.range ?? 30) + 1) % ranges.length] };
        return load().then(() => undefined);
      },
      c: async () => {
        if (!st.report) return;
        const file = await ctx.services.saveUsageCard(shareCardSvg(st.report.overview));
        return `Saved ${file}`;
      },
    },
    step: (dir) => {
      const at = USAGE_TABS.findIndex((t) => t.key === st.tab);
      st.tab = USAGE_TABS[(at + dir + USAGE_TABS.length) % USAGE_TABS.length]!.key;
      draw(true);
    },
  });
  ctx.host.push(view);
  void load().catch((e) => view.setLines([{ text: e instanceof Error ? e.message : String(e), tone: "error" }]));
  void ctx.services
    .usageCredits()
    .then((c) => {
      st.credits = c;
      draw();
    })
    .catch(() => {
      st.credits = { state: "unavailable" };
      draw();
    });
}

// ─── /export, /import ────────────────────────────────────────────────────────

export interface ExportArgs {
  file?: string;
  json: boolean;
  sanitize: boolean;
}

export function parseExportArgs(rest: string): ExportArgs {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const json = words.includes("--json") || words.some((w) => w.endsWith(".json"));
  return {
    json,
    sanitize: words.includes("--sanitize"),
    file: words.find((w) => !w.startsWith("--")),
  };
}

/** Writes the file; returns the notice to show. */
export function runExport(ctx: ScreenContext, rest: string): string {
  const { title, messages, model } = ctx.session.exportable();
  if (!messages.length) return "Nothing to export yet.";
  const args = parseExportArgs(rest);
  let doc: PortableSession = fromAtlarixMessages(messages, {
    title,
    workspace: ctx.session.workspaceDir,
    model: model?.name,
    now: ctx.now?.(),
  });
  if (args.sanitize) doc = sanitizeSession(doc, os.homedir());
  const ext = args.json ? "json" : "md";
  const file = path.resolve(ctx.session.workspaceDir, args.file ?? exportFileName(doc.title, ext, ctx.now?.()));
  fs.writeFileSync(file, args.json ? JSON.stringify(doc, null, 2) + "\n" : toMarkdown(doc));
  return `Exported to ${file.replace(os.homedir(), "~")}${args.sanitize ? " (sanitized)" : ""}.`;
}

async function importPortable(ctx: ScreenContext, doc: PortableSession): Promise<void> {
  const messages = doc.messages
    .map((m) => ({ role: m.role, content: messageContent(m) }))
    .filter((m) => m.content.trim());
  if (!messages.length) throw new Error("That session has no messages to import.");
  const from = doc.source === "atlarix" ? "" : ` (from ${doc.source === "claude-code" ? "Claude Code" : doc.source})`;
  await ctx.session.importMessages(`${doc.title}${from}`, messages);
  ctx.host.closeAll();
  ctx.flash(`Imported “${doc.title}”${from}: ${messages.length} messages. Carry on from here.`);
}

export async function runImport(ctx: ScreenContext, rest: string): Promise<void> {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const fromIdx = words.indexOf("--from");
  const source = (fromIdx >= 0 ? words[fromIdx + 1] : undefined) as ImportSource | undefined;
  if (fromIdx >= 0 && source && SOURCE_NAMES[source]) return openForeignSessions(ctx, source);
  if (fromIdx >= 0) return ctx.flash("--from takes claude, codex or opencode.");
  const file = words[0];
  if (file) {
    const full = path.resolve(ctx.session.workspaceDir, file.replace(/^~(?=\/)/, os.homedir()));
    let raw: string;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch {
      return ctx.flash(`Can't read ${file}.`);
    }
    const doc = parsePortable(raw);
    if (!doc) return ctx.flash(`${file} isn't an Atlarix export (/export --json writes one).`);
    return importPortable(ctx, doc).catch((e) => ctx.flash(e instanceof Error ? e.message : String(e)));
  }
  ctx.host.push(
    new ListDialog({
      title: "Import a session",
      intro: [{ text: "Bring a conversation from another agent into this folder, and carry on here.", tone: "muted" }],
      footer: "↑↓ move · enter choose · esc close",
      items: [
        ...(Object.keys(SOURCE_NAMES) as ImportSource[]).map((s) => ({ id: s, label: `From ${SOURCE_NAMES[s]}` })),
        { id: "file", label: "From a file…", detail: "an Atlarix export (.json)" },
      ],
      onChoose: (item) => {
        if (item.id !== "file") return openForeignSessions(ctx, item.id as ImportSource);
        ctx.host.push(
          new InputDialog({
            title: "Import from a file",
            label: "Path to the .json export",
            onSubmit: async (v) => {
              ctx.host.closeAll();
              await runImport(ctx, v.trim());
            },
          }),
        );
      },
    }),
  );
}

async function openForeignSessions(ctx: ScreenContext, source: ImportSource): Promise<void> {
  const now = ctx.now?.() ?? new Date();
  const found = new Map<string, Awaited<ReturnType<typeof listForeignSessions>>[number]>();
  ctx.host.push(
    new ListDialog({
      title: `Import from ${SOURCE_NAMES[source]}`,
      searchable: true,
      empty: `No ${SOURCE_NAMES[source]} sessions for this folder.`,
      footer: "type to search · enter import · esc back",
      items: async () => {
        const list = await listForeignSessions(source, ctx.session.workspaceDir);
        found.clear();
        for (const s of list) found.set(s.id, s);
        return list.map((s) => ({ id: s.id, label: s.title || "Untitled", detail: ago(s.updatedAt, now) }));
      },
      onChoose: async (item) => {
        const s = found.get(item.id);
        if (s) await importPortable(ctx, s.load());
      },
    }),
  );
}
