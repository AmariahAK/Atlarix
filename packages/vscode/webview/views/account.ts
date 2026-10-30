/**
 * Account: who you are (your picture, name and email, how you signed in, your
 * plan), your credit (Add credit, Get Pro or Manage), free Atlarix Auto left
 * today when the proxy has said, this chat's tokens and cost, and Sign out
 * (shared with the app and CLI). Signed out, one card to sign in.
 */
import { post, rpc } from "../rpc";
import { state } from "../state";
import { button, el, eyebrow, money, pageHeader, rixGlyph, tokens } from "../ui";
import type { Nav } from "./nav";

interface Account {
  email: string | null;
  name?: string | null;
  /** A data: URL, fetched by the agent (the page loads nothing from the web). */
  avatar?: string | null;
  provider?: string | null;
  kind: "signed-out" | "free" | "pro" | "payg" | null;
  balanceCents: number | null;
  usage: { tokens: number; cachedTokens: number; costUsd: number; contextPercent: number | null } | null;
  freeAutoLeft: number | null;
}

const PLAN: Record<string, string> = { "signed-out": "Not signed in", free: "Free", pro: "Pro", payg: "Pay as you go" };
const PROVIDER: Record<string, string> = { github: "GitHub", google: "Google", email: "Email" };

export async function renderAccount(page: HTMLElement, nav: Nav): Promise<void> {
  page.textContent = "";
  page.append(pageHeader("Account", () => nav.back()));
  const body = el("div", "page__body account");
  body.append(el("div", "muted pad", "Loading…"));
  page.append(body);
  const a = await rpc<Account>("_atlarix/account", state.sessionId ? { sessionId: state.sessionId } : {}).catch(() => null);
  body.textContent = "";
  if (!a) return void body.append(el("div", "error", "Couldn't read your account."));

  if (!a.email) {
    // Signed out (here, or in the app or CLI): one way back in.
    const card = el("section", "signin-card");
    const mark = el("span", "signin-card__mark");
    mark.innerHTML = rixGlyph(30);
    card.append(
      mark,
      el("strong", "", "Sign in to Atlarix"),
      el("span", "muted small", "With GitHub, Google or email, in your browser. The Atlarix app and CLI on this computer share it."),
      button("Sign in", "primary wide", () => post({ type: "sign-in" })),
    );
    body.append(card);
    return;
  }

  // Who you are.
  const who = el("section", "profile");
  const avatar = el("span", "profile__avatar");
  if (a.avatar?.startsWith("data:image/")) {
    const img = el("img", "");
    img.src = a.avatar;
    img.alt = "";
    avatar.append(img);
  } else avatar.textContent = (a.name ?? a.email).charAt(0).toUpperCase();
  avatar.setAttribute("aria-hidden", "true");
  const id = el("div", "profile__id");
  id.append(el("strong", "profile__name", a.name ?? a.email));
  if (a.name) id.append(el("span", "profile__email", a.email));
  const chips = el("div", "profile__chips");
  if (a.provider && PROVIDER[a.provider]) chips.append(el("span", "chip-tag", `Signed in with ${PROVIDER[a.provider]}`));
  chips.append(el("span", `chip-tag plan ${a.kind ?? ""}`, PLAN[a.kind ?? "signed-out"] ?? "—"));
  id.append(chips);
  who.append(avatar, id);
  body.append(who);

  // Your credit.
  const credit = el("section", "credit-card");
  const top = el("div", "credit-card__top");
  const left = el("div", "col");
  left.append(el("span", "credit-card__label", "Credit"), el("div", "credit-card__amount", money(a.balanceCents)));
  top.append(left);
  credit.append(top, el("span", "muted small", a.kind === "pro" ? "Pro covers your plan; credit pays for anything past it." : "Pays for Atlarix Auto and Core as you use them."));
  const acts = el("div", "credit-card__acts");
  acts.append(button("Add credit", "primary", () => post({ type: "checkout", kind: "credit" })));
  if (a.kind !== "pro") acts.append(button("Get Pro", "", () => post({ type: "checkout", kind: "pro" })));
  else acts.append(button("Manage subscription", "", () => post({ type: "manage-subscription" })));
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

  // This chat.
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

  const links = el("div", "account__links");
  links.append(
    button("Usage", "link small", () => nav.go({ name: "usage" })),
    button("Usage and invoices ↗", "link small", () => post({ type: "open-url", url: "https://www.atlarix.dev/account" })),
    button("Pricing ↗", "link small", () => post({ type: "open-url", url: "https://www.atlarix.dev/pricing" })),
  );
  body.append(links);

  const out = el("div", "page__foot account__out");
  const note = el("div", "col grow");
  note.append(el("strong", "small", "Sign out"), el("span", "muted small", "Signs out the Atlarix app and CLI on this computer too."));
  out.append(note, button("Sign out", "deny small", () => post({ type: "sign-out" })));
  body.append(out);
}
