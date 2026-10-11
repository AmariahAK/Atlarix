/**
 * Account: who you're signed in as, your plan and credit (Add credit, Get Pro),
 * free Atlarix Auto left today when the proxy has said, this chat's tokens and
 * cost, and Sign out (shared with the app and CLI).
 */
import { post, rpc } from "../rpc";
import { state } from "../state";
import { button, el, eyebrow, money, pageHeader, tokens } from "../ui";
import type { Nav } from "./nav";

interface Account {
  email: string | null;
  kind: "signed-out" | "free" | "pro" | "payg" | null;
  balanceCents: number | null;
  usage: { tokens: number; cachedTokens: number; costUsd: number; contextPercent: number | null } | null;
  freeAutoLeft: number | null;
}

const PLAN: Record<string, string> = { "signed-out": "Not signed in", free: "Free", pro: "Pro", payg: "Pay as you go" };

export async function renderAccount(page: HTMLElement, nav: Nav): Promise<void> {
  page.textContent = "";
  page.append(pageHeader("Account", () => nav.back()));
  const body = el("div", "page__body");
  body.append(el("div", "muted pad", "Loading…"));
  page.append(body);
  const a = await rpc<Account>("_atlarix/account", state.sessionId ? { sessionId: state.sessionId } : {}).catch(() => null);
  body.textContent = "";
  if (!a) return void body.append(el("div", "error", "Couldn't read your account."));

  const who = el("div", "who");
  const avatar = el("span", "avatar", (a.email ?? "?").charAt(0).toUpperCase());
  avatar.setAttribute("aria-hidden", "true");
  const id = el("div", "who__id");
  id.append(el("strong", "", a.email ?? "Not signed in"), el("span", "muted small", "Shared with the Atlarix app and CLI"));
  who.append(avatar, id);
  body.append(who);

  if (!a.email) {
    body.append(button("Sign in", "primary wide", () => post({ type: "sign-in" })));
    return;
  }

  const credit = el("section", "credit-card");
  const top = el("div", "credit-card__top");
  const left = el("div", "");
  left.append(el("span", "muted small", PLAN[a.kind ?? "signed-out"] ?? "—"), el("div", "credit-card__amount", money(a.balanceCents)));
  top.append(left, el("span", "muted small", "credit left"));
  credit.append(top);
  const acts = el("div", "row gap");
  acts.append(button("Add credit", "primary grow", () => post({ type: "checkout", kind: "credit" })));
  if (a.kind !== "pro") acts.append(button("Get Pro", "grow", () => post({ type: "checkout", kind: "pro" })));
  else acts.append(button("Manage subscription", "grow", () => post({ type: "manage-subscription" })));
  credit.append(acts);
  if (a.freeAutoLeft != null) {
    const free = el("div", "credit-card__free");
    const row = el("div", "row between small");
    row.append(el("span", "muted", "Free Atlarix Auto today"), el("span", "", `${Math.round(a.freeAutoLeft)}% left`));
    const bar = el("span", "bar");
    const fill = el("span", "bar__fill");
    fill.style.width = `${Math.round(a.freeAutoLeft)}%`;
    bar.append(fill);
    free.append(row, bar);
    credit.append(free);
  }
  body.append(credit);

  if (a.usage && (a.usage.tokens || a.usage.costUsd)) {
    body.append(eyebrow("THIS CHAT"));
    const grid = el("div", "stat-grid");
    const stat = (k: string, v: string) => {
      const s = el("div", "stat");
      s.append(el("span", "muted small", k), el("strong", "mono", v));
      grid.append(s);
    };
    stat("Tokens", tokens(a.usage.tokens));
    stat("From cache", tokens(a.usage.cachedTokens));
    stat("Your keys", a.usage.costUsd > 0 ? `$${a.usage.costUsd.toFixed(a.usage.costUsd < 1 ? 3 : 2)}` : "$0");
    body.append(grid);
  }
  body.append(button("All usage on atlarix.dev ↗", "link", () => post({ type: "open-url", url: "https://www.atlarix.dev/account" })));

  const out = el("div", "page__foot");
  out.append(el("span", "muted small grow", "Signs out the app and CLI on this computer too."), button("Sign out", "small", () => post({ type: "sign-out" })));
  body.append(out);
}
