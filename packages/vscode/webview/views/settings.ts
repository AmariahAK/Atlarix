/**
 * Settings: Models & keys (the default model, a different model for Plan, and
 * every provider: your keys with whether each works, on/off, local servers,
 * your own endpoints), Auto-approve, Browser and General.
 */
import type { ProviderRow } from "../../src/protocol";
import { closePicker, openPicker } from "../chat/picker";
import { post, rpc } from "../rpc";
import { checkKey, emit, loadProviders, modelName, on, state } from "../state";
import { button, el, eyebrow, icon, initials, money, pageHeader, rixGlyph, segmented, toggle } from "../ui";
import type { Nav } from "./nav";

type Tab = "keys" | "approve" | "browser" | "general";
const TABS: Array<[Tab, string]> = [
  ["keys", "Models & keys"],
  ["approve", "Auto-approve"],
  ["browser", "Browser"],
  ["general", "General"],
];

export const KEYS_NOTE = "Keys stay on this computer, shared with the Atlarix app and CLI.";

let unsub: (() => void) | null = null;

export function renderSettings(page: HTMLElement, nav: Nav, tab: Tab = "keys"): void {
  unsub?.();
  unsub = null;
  page.textContent = "";
  page.append(pageHeader("Settings", () => nav.back()));
  const tabs = el("nav", "tabs");
  tabs.setAttribute("aria-label", "Settings sections");
  for (const [id, name] of TABS) {
    const t = button(name, `tab${id === tab ? " on" : ""}`, () => renderSettings(page, nav, id));
    if (id === tab) t.setAttribute("aria-current", "page");
    tabs.append(t);
  }
  const body = el("div", "page__body");
  page.append(tabs, body);
  if (tab === "keys") renderKeys(body, nav);
  else if (tab === "approve") void renderApprove(body);
  else if (tab === "browser") renderBrowser(body);
  else renderGeneral(body);
}

// --- Models & keys ----------------------------------------------------------------------

function renderKeys(body: HTMLElement, nav: Nav): void {
  // Fetched once per visit; key checks arriving redraw from these.
  let account: Account | null | undefined;
  let local: LocalServer[] = [];
  const draw = () => {
    body.textContent = "";
    body.append(modelsCard());
    const head = el("div", "row between");
    head.append(eyebrow("PROVIDERS"), button("+ Add", "link small", () => nav.go({ name: "add-provider" })));
    body.append(head);
    const list = el("div", "prov-list");
    body.append(list);
    list.append(atlarixRow(account));
    const providers = state.providers ?? [];
    for (const p of providers.filter((x) => x.hasKey || x.custom)) list.append(providerRow(p, nav));
    for (const l of local.filter((x) => x.running)) {
      const r = el("div", "prov");
      const badge = el("span", "prov__badge");
      badge.innerHTML = icon("monitor", 14);
      const text = el("span", "prov__text");
      text.append(el("strong", "", l.name), el("span", "muted small", `On this computer · ${l.models} model${l.models === 1 ? "" : "s"} · no key needed`));
      r.append(badge, text, status("works", "Running"));
      list.append(r);
    }
    if (!providers.some((p) => p.hasKey)) list.append(el("div", "empty-note", "No keys of your own yet. Add a provider to use its models."));
    body.append(el("p", "foot-note", KEYS_NOTE));
  };
  draw();
  void Promise.all([
    loadProviders(),
    rpc<Account>("_atlarix/account").then((a) => (account = a), () => (account = null)),
    rpc<{ local: LocalServer[] }>("_atlarix/local_providers").then((r) => (local = r.local), () => (local = [])),
  ]).then(draw);
  unsub = on("keys", draw);
}

type Account = { email: string | null; kind: string | null; balanceCents: number | null };
type LocalServer = { id: string; name: string; running: boolean; models: number };

function status(kind: string, text: string, title?: string): HTMLElement {
  const s = el("span", `status ${kind}`);
  s.append(el("span", "dot"), el("span", "", text));
  if (title) s.title = title;
  return s;
}

/** The default model, and "A different model for Plan". */
function modelsCard(): HTMLElement {
  const card = el("section", "card-plain");
  const top = el("div", "row between");
  const left = el("div", "col");
  left.append(el("span", "muted small", "Default model"), el("strong", "", modelName() || "—"));
  top.append(
    left,
    button("Change", "small", () =>
      openPicker({
        current: state.modelValue,
        full: true,
        onChoose: (value) => {
          state.modelValue = value;
          post({ type: "set-option", configId: "model", value });
          emit("options");
          emit("keys");
        },
      }),
    ),
  );
  card.append(top);

  const plan = el("div", "row between plan-model");
  const text = el("div", "col");
  const planOn = !!state.planModel;
  text.append(
    el("span", "", "A different model for Plan"),
    el("span", "muted small", planOn ? `Plan with ${modelName(state.planModel!)}, build with ${modelName()}` : "Plan with a stronger model, build with this one"),
  );
  const choosePlan = () =>
    openPicker({
      current: state.planModel ?? "",
      full: false,
      onChoose: async (value) => {
        const r = await rpc<{ model: string | null }>("_atlarix/plan_model", { model: value || null }).catch(() => null);
        state.planModel = r?.model ?? null;
        emit("keys");
      },
    });
  plan.append(
    text,
    toggle(planOn, "A different model for Plan", async (onNow) => {
      if (onNow) return choosePlan();
      closePicker();
      await rpc("_atlarix/plan_model", { model: null }).catch(() => {});
      state.planModel = null;
      emit("keys");
    }),
  );
  card.append(plan);
  if (planOn) card.append(button(`Plan model: ${modelName(state.planModel!)}`, "link small", choosePlan));
  return card;
}

function atlarixRow(a: Account | null | undefined): HTMLElement {
  const r = el("div", "prov");
  const badge = el("span", "prov__badge brand");
  badge.innerHTML = rixGlyph(16);
  const text = el("span", "prov__text");
  text.append(
    el("strong", "", "Atlarix"),
    el("span", "muted small", a === undefined ? "…" : a?.email ? `Signed in · Auto free · ${money(a.balanceCents)} credit` : "Sign in to use Atlarix Auto and Core"),
  );
  r.append(badge, text, a === undefined ? el("span", "") : a?.email ? status("works", "Signed in") : button("Sign in", "small", () => post({ type: "sign-in" })));
  return r;
}

/** A provider's own words, without the wall of asterisks a masked key prints ("sk-proj-****…UcIA"). */
function tidyDetail(detail: string): string {
  return detail.replace(/(\S{0,12}?)\*{4,}(\S{0,8})/g, (_m, head: string, tail: string) => `${head}…${tail}`);
}

function providerRow(p: ProviderRow, nav: Nav): HTMLElement {
  const c = state.keyChecks.get(p.id);
  const bad = c?.status === "rejected";
  const row = el("div", `prov${bad ? " bad" : ""}${p.off ? " off" : ""}`);
  const open = button("", "prov__open", () => nav.go({ name: "provider", id: p.id }));
  const badge = el("span", "prov__badge", initials(p.name));
  const text = el("span", "prov__text");
  const count = state.modelGroups.flatMap((g) => g.options).filter((o) => o.value.startsWith(`${p.id}/`)).length;
  const hint = p.keyHint === "none" ? "no key needed" : p.keyHint;
  text.append(
    el("strong", "", p.name),
    el("span", "muted small mono", p.off ? "Off · key kept, models hidden" : [hint, count ? `${count} model${count === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")),
  );
  open.append(badge, text);
  row.append(open);
  if (!p.off && c) {
    row.append(
      c.status === "checking"
        ? status("checking", "Checking…")
        : c.status === "works"
          ? status("works", "Works", c.detail)
          : c.status === "rejected"
            ? status("bad", "Key rejected", c.detail && tidyDetail(c.detail))
            : status("muted", c.status === "unchecked" ? "Not checked" : "Couldn't reach it", c.detail),
    );
  }
  row.append(
    toggle(!p.off, `${p.name} on`, async (onNow) => {
      await rpc("_atlarix/provider_enabled", { providerId: p.id, on: onNow }).catch(() => {});
      await loadProviders(true);
    }),
  );

  // Remove the key right here, not only from the provider's own page (owner:
  // "not seeing a delete key"). Asks once, in place.
  const wrap = el("div", `prov-wrap${bad ? " bad" : ""}`);
  const confirmSlot = el("div", "");
  const askRemove = () => {
    confirmSlot.textContent = "";
    const ask = el("div", "prov__fix");
    ask.append(
      el("span", "small grow bad", `Remove the ${p.name} key?${p.custom ? " This removes the provider too." : ""} Chats on its models move to Atlarix Auto.`),
      button("Remove", "deny-solid small", async () => {
        await rpc("_atlarix/provider_key", { providerId: p.id, key: null }).catch(() => {});
        state.keyChecks.delete(p.id);
        await loadProviders(true);
      }),
      button("Keep", "small", () => (confirmSlot.textContent = "")),
    );
    confirmSlot.append(ask);
  };
  const trash = button("", "icon small prov__remove", askRemove, `Remove the ${p.name} key`);
  trash.innerHTML = icon("trash", 14);
  row.append(trash);

  wrap.append(row);
  if (bad) {
    const fix = el("div", "prov__fix");
    fix.append(
      el("span", "muted small grow", c?.detail ? tidyDetail(c.detail) : `${p.name} rejected this key.`),
      button("Remove key", "deny small", askRemove),
      button("Replace key", "primary small", () => nav.go({ name: "provider", id: p.id })),
    );
    wrap.append(fix);
  }
  wrap.append(confirmSlot);
  return wrap;
}

// --- Auto-approve -----------------------------------------------------------------------

async function renderApprove(body: HTMLElement): Promise<void> {
  body.textContent = "";
  body.append(el("div", "muted pad", "Loading…"));
  const r = await rpc<{ folderEdits: boolean; rules: Array<{ kind: string; label: string; decision: "always" | "never"; risky: boolean }> }>("_atlarix/permissions", {
    sessionId: state.sessionId,
    action: "list",
  }).catch(() => null);
  body.textContent = "";
  if (!r) return void body.append(el("div", "error", "Start a chat in a folder to see its rules."));

  const card = el("section", "card-plain list");
  const line = (title: string, sub: string, control: HTMLElement | null) => {
    const row = el("div", "setting");
    const t = el("div", "col grow");
    t.append(el("span", "", title), el("span", "muted small", sub));
    row.append(t);
    if (control) row.append(control);
    card.append(row);
  };
  // What actually happens (QA: it read /etc/hosts without asking, as designed:
  // reading is open everywhere, as in the app; changing files outside asks).
  line("Read files", "Always, in this folder and elsewhere; changing anything outside it asks first", status("works", "Always"));
  line(
    "Edit files in this folder without asking",
    r.folderEdits ? "Edits apply as they're made; deletes and renames still ask" : "Off: every edit shows its diff first",
    toggle(r.folderEdits, "Edit files in this folder without asking", async (onNow) => {
      await rpc("_atlarix/permissions", { sessionId: state.sessionId, action: "edits", on: onNow }).catch(() => {});
      void renderApprove(body);
      window.dispatchEvent(new CustomEvent("atlarix-approve-changed"));
    }),
  );
  line("Run commands", "Safe ones run; risky ones (deleting, installing, sudo) always ask", null);
  body.append(card);

  body.append(eyebrow("REMEMBERED IN THIS FOLDER"));
  const rules = el("section", "card-plain list");
  if (!r.rules.length) rules.append(el("div", "empty-note", "Nothing yet. Choosing “Always” on an approval adds it here."));
  r.rules.forEach((rule, i) => {
    const row = el("div", "setting");
    row.append(el("span", `mono grow${rule.risky ? " warn" : ""}`, rule.label), el("span", rule.decision === "never" ? "bad small" : "ok small", rule.decision === "never" ? "Never" : "Always"));
    row.append(
      button("Forget", "link small", async () => {
        await rpc("_atlarix/permissions", { sessionId: state.sessionId, action: "revoke", index: i }).catch(() => {});
        void renderApprove(body);
      }),
    );
    rules.append(row);
  });
  body.append(rules);

  const more = el("section", "card-plain list");
  const row1 = el("div", "setting");
  row1.append(el("span", "grow", "Tell me when Atlarix needs me"), toggle(state.settings.notifyWhenNeeded, "Tell me when Atlarix needs me", (v) => post({ type: "host-setting", key: "notifyWhenNeeded", value: v })));
  const row2 = el("div", "setting");
  row2.append(
    el("span", "grow", "One-line recap when I come back"),
    toggle(state.recapOn, "One-line recap when I come back", async (v) => {
      state.recapOn = v;
      await rpc("_atlarix/recap_setting", { on: v }).catch(() => {});
    }),
  );
  more.append(row1, row2);
  body.append(more);
}

// --- Browser, General -------------------------------------------------------------------

function renderBrowser(body: HTMLElement): void {
  body.textContent = "";
  const connected = !!state.chrome && !/not connected|unavailable/i.test(state.chrome);
  const card = el("section", "card-plain");
  const row = el("div", "setting");
  const t = el("div", "col grow");
  t.append(el("span", "", "Your Chrome"), el("span", "muted small", connected ? state.chrome : "Atlarix uses your own Chrome, through its extension, to read pages and do browser tasks."));
  row.append(t, status(connected ? "works" : "muted", connected ? "Connected" : "Not connected"));
  card.append(row);
  if (!connected) card.append(button("Get the Chrome extension ↗", "primary small", () => post({ type: "open-url", url: "https://chromewebstore.google.com/detail/fkoacefbjjjhjceidagdajkgclfjacbe" })));
  body.append(card, el("p", "foot-note", "Atlarix always stops before a final submit in your browser."));
}

function renderGeneral(body: HTMLElement): void {
  body.textContent = "";
  const card = el("section", "card-plain list");
  const row = (title: string, sub: string, key: "attachOpenFile" | "ctrlEnterSends") => {
    const r = el("div", "setting");
    const t = el("div", "col grow");
    t.append(el("span", "", title), el("span", "muted small", sub));
    r.append(t, toggle(state.settings[key], title, (v) => post({ type: "host-setting", key, value: v })));
    card.append(r);
  };
  row("Send the open file with each message", "Shown in the box; remove it there to leave it out", "attachOpenFile");
  row("Send with Ctrl+Enter", "Enter then adds a new line", "ctrlEnterSends");
  body.append(card);

  // Context window — one shared setting (the app's Settings, the CLI's /context,
  // ACP and here). It is not per-chat: it decides when any session compacts.
  const ctxCard = el("section", "card-plain list");
  const ctxRow = el("div", "setting");
  const ctxT = el("div", "col grow");
  ctxT.append(
    el("span", "", "Context window"),
    el("span", "muted small", "How much of the conversation to keep before Atlarix compacts it. 512k and Full keep more; every step costs more."),
  );
  const ctxOptions = [
    { value: "256k", name: "256K" },
    { value: "512k", name: "512K" },
    { value: "full", name: "Full" },
  ];
  ctxRow.append(
    ctxT,
    segmented(ctxOptions, state.context?.value ?? "256k", "Context window", (v) => {
      post({ type: "set-option", configId: "context", value: v });
      if (state.context) state.context.value = v;
    }),
  );
  ctxCard.append(ctxRow);
  body.append(ctxCard);

  body.append(eyebrow("THIS CHAT"));
  const acts = el("section", "card-plain list");
  const act = (label: string, run: () => void) => {
    const b = button("", "setting link-row", run);
    b.append(el("span", "grow", label));
    b.insertAdjacentHTML("beforeend", icon("right", 12));
    acts.append(b);
  };
  act("Open in an editor tab", () => post({ type: "open-in-tab" }));
  act("Continue in the Atlarix app", () => post({ type: "continue-in-app" }));
  act("Continue in the terminal", () => post({ type: "continue-in-terminal" }));
  act("Show log", () => post({ type: "show-log" }));
  body.append(acts);
}

export { checkKey };
