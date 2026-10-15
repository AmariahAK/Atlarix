/**
 * MCP servers: the account's web servers (every device and the Chrome
 * extension) and this computer's for this folder, each with its state, tools,
 * on/off, Test, Remove and Sign in. Browse searches the marketplace (the
 * official MCP Registry, Verified first); Add takes a URL, a command or a
 * pasted mcpServers config.
 */
import { rpc } from "../rpc";
import { state } from "../state";
import { button, el, pageHeader, toggle } from "../ui";
import { mcpIcon } from "../mcp-icon";
import type { Nav } from "./nav";

interface Server {
  id: number;
  name: string;
  transport: string;
  enabled: boolean;
}
interface AccountServer {
  id: string;
  name: string;
  url: string;
  authType: "none" | "oauth" | "api_key" | "header";
  authHeader: string | null;
  enabled: boolean;
  connected: boolean;
  lastError: string | null;
  tools: string[];
}
interface Added {
  where: "account" | "local";
  id: string | number;
  name: string;
  enabled: boolean;
  needsSignIn: boolean;
  needsSecret?: { header: string | null };
  note?: string;
}
interface CatalogInput {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  default?: string;
  placeholder?: string;
}
interface CatalogOption {
  id: string;
  kind: "web" | "local";
  url?: string;
  registryType?: string;
  identifier?: string;
  supported?: boolean;
  inputs: CatalogInput[];
}
interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  publisher: string;
  verified: boolean;
  kind: "web" | "local";
  options: CatalogOption[];
}
type Health = { ok: boolean; error?: string; needsOAuth?: boolean } | "checking";

export async function renderMcp(page: HTMLElement, nav: Nav): Promise<void> {
  page.textContent = "";
  // Browse and Add sit in the body: in the header they squeezed the title to "MCP ser…" (QA #12).
  const add = button("Add your own", "small", () => showForm());
  const browse = button("Browse marketplace", "primary small", () => showBrowse());
  page.append(pageHeader("MCP servers", () => nav.back()));
  const body = el("div", "page__body");
  const actions = el("div", "mcp__actions");
  actions.append(browse, add);
  body.append(actions);
  const list = el("div", "mcp__list");
  const accountSlot = el("div", "");
  const formSlot = el("div", "");
  const foundSlot = el("div", "");
  const defaultsSlot = el("div", "");
  const notice = el("div", "muted small hidden");
  body.append(formSlot, notice, accountSlot, list, defaultsSlot, foundSlot);
  page.append(body);
  const say = (text: string, bad = false) => {
    notice.textContent = text;
    notice.classList.toggle("hidden", !text);
    notice.classList.toggle("bad", bad);
  };

  const call = <T>(action: string, extra: Record<string, unknown> = {}) => rpc<T>("_atlarix/mcp", { sessionId: state.sessionId, action, ...extra });
  let servers: Server[] = [];
  const health = new Map<number, Health>();
  const tools = new Map<number, Array<{ name: string }>>();
  const open = new Set<number>();
  let confirming: number | null = null;

  const test = async (s: Server) => {
    health.set(s.id, "checking");
    draw();
    const r = await call<{ result?: { ok: boolean; error?: string; needsOAuth?: boolean } }>("test", { id: s.id }).catch((e: Error) => ({ result: { ok: false, error: e.message } }));
    health.set(s.id, r.result ?? { ok: false });
    if (r.result?.ok && !tools.has(s.id)) {
      const t = await call<{ tools?: Array<{ name: string }> }>("tools", { id: s.id }).catch(() => ({ tools: [] }));
      tools.set(s.id, t.tools ?? []);
    }
    draw();
  };

  const load = async () => {
    const r = await call<{ servers?: Server[] }>("list").catch(() => ({ servers: [] }));
    servers = r.servers ?? [];
    draw();
    for (const s of servers) if (s.enabled) void test(s);
    void drawAccount();
    void drawDefaults();
    void drawFound();
  };

  /** The user's defaults not added here: Add opens the marketplace on that server. */
  const drawDefaults = async () => {
    const r = await call<{ defaults?: Array<{ name: string; title: string; state: string }> }>("defaults").catch(() => ({ defaults: [] }));
    defaultsSlot.textContent = "";
    const missing = (r.defaults ?? []).filter((d) => d.state === "not-added");
    if (!missing.length) return;
    defaultsSlot.append(el("div", "eyebrow", "YOUR DEFAULTS"));
    const box = el("div", "card-plain list");
    for (const d of missing) {
      const row = el("div", "setting");
      row.append(mcpIcon({ name: d.name }, d.title, 28));
      const t = el("div", "col grow");
      t.append(el("strong", "", d.title), el("span", "muted small", "Not added here"));
      row.append(t, button("Add", "small", () => showBrowse(d.title)));
      box.append(row);
    }
    defaultsSlot.append(box);
  };

  /** After an add: start a sign-in, ask for a missing key, or say it worked. */
  const finish = async (added: Added[]) => {
    for (const a of added) {
      if (a.needsSignIn) {
        say(`Sign in to ${a.name} in your browser…`);
        if (a.where === "account") {
          const r = await call<{ result?: { ok: boolean; enabled: boolean; error?: string } }>("accountSignIn", { id: a.id }).catch(
            (e: Error) => ({ result: { ok: false, enabled: false, error: e.message } }),
          );
          say(r.result?.ok ? `${a.name} is ${r.result.enabled ? "on" : "signed in"}.` : (r.result?.error ?? `Couldn't sign in to ${a.name}.`), !r.result?.ok);
        } else {
          await call("oauth", { id: a.id }).catch(() => {});
        }
        continue;
      }
      if (a.needsSecret && a.where === "account") {
        askSecret(String(a.id), a.name, a.needsSecret.header);
        continue;
      }
      say(a.note ? `${a.name}: ${a.note}` : `${a.name} added.`);
    }
    await load();
  };

  const askSecret = (id: string, name: string, header: string | null) => {
    formSlot.textContent = "";
    const f = el("form", "inline-form");
    const input = el("input", "field mono");
    input.type = "password";
    input.placeholder = header ?? "API key";
    const acts = el("div", "row gap end");
    acts.append(button("Later", "small", () => (formSlot.textContent = "")));
    const submit = el("button", "primary small", "Save");
    submit.type = "submit";
    acts.append(submit);
    f.append(el("strong", "", name), input, acts);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      await call("accountSecret", { id, secret: input.value.trim() }).catch((x: Error) => say(x.message, true));
      formSlot.textContent = "";
      await load();
    });
    formSlot.append(f);
    input.focus();
  };

  /** Web servers on the account: shared with every device and the Chrome extension. */
  const drawAccount = async () => {
    const r = await call<{ servers?: AccountServer[] | null }>("account").catch(() => ({ servers: null }));
    accountSlot.textContent = "";
    const rows = r.servers ?? [];
    if (!rows.length) return;
    accountSlot.append(el("div", "eyebrow", "ON ALL YOUR DEVICES"));
    for (const c of rows) {
      const needsSignIn = c.authType === "oauth" && !c.connected;
      const needsKey = (c.authType === "api_key" || c.authType === "header") && !c.connected;
      const status = needsSignIn || needsKey ? "signin" : c.enabled ? (c.lastError ? "bad" : "ok") : "off";
      const card = el("div", `mcp-card ${status}`);
      const head = el("div", "mcp-card__head");
      const label = el("div", "mcp-card__name");
      const sub = needsSignIn
        ? "Needs you to sign in"
        : needsKey
          ? "Needs its key"
          : !c.enabled
            ? "Off"
            : c.lastError
              ? c.lastError
              : `${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}`;
      label.append(el("span", "dot"), mcpIcon({ url: c.url }, c.name), el("span", "grow"));
      label.lastElementChild!.append(el("strong", "", c.name), el("span", "mcp-card__sub", sub));
      head.append(label);
      if (needsSignIn) {
        head.append(button("Sign in", "small", () => void finish([{ where: "account", id: c.id, name: c.name, enabled: false, needsSignIn: true }])));
      }
      if (needsKey) head.append(button("Add key", "small", () => askSecret(c.id, c.name, c.authHeader)));
      if (!needsSignIn && !needsKey) {
        head.append(
          toggle(c.enabled, `${c.name} on`, async (on) => {
            await call("accountSet", { id: c.id, enabled: on }).catch((x: Error) => say(x.message, true));
            await drawAccount();
          }),
        );
      }
      head.append(
        button("Remove", "link small bad", async () => {
          await call("accountRemove", { id: c.id }).catch((x: Error) => say(x.message, true));
          await drawAccount();
        }),
      );
      card.append(head);
      accountSlot.append(card);
    }
  };

  /** The marketplace, searched in Atlarix's cached copy of the registry. */
  const showBrowse = (query = "") => {
    formSlot.textContent = "";
    const box = el("div", "inline-form");
    const search = el("input", "field");
    search.placeholder = "Search MCP servers";
    search.value = query;
    const results = el("div", "list");
    const head = el("div", "row gap");
    head.append(search, button("Close", "small", () => (formSlot.textContent = "")));
    box.append(head, results);
    formSlot.append(box);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const r = await call<{ entries?: CatalogEntry[]; total?: number; installed?: string[] }>("catalog", { query: search.value.trim() }).catch(
        () => ({ entries: [], total: 0, installed: [] }),
      );
      results.textContent = "";
      const installed = new Set(r.installed ?? []);
      if (!r.entries?.length) results.append(el("div", "empty-note", "No servers match."));
      for (const e of (r.entries ?? []).slice(0, 25)) {
        const row = el("div", "setting");
        row.append(mcpIcon({ name: e.name }, e.title, 28));
        const t = el("div", "col grow");
        const name = el("span", "");
        const meta = [e.verified ? "✓ Verified" : e.publisher?.trim(), e.kind === "web" ? "web" : "local"].filter(Boolean).join(" · ");
        name.append(el("strong", "", e.title), el("span", "muted small", ` · ${meta}`));
        const sub = el("span", "muted small", e.description);
        sub.style.overflow = "hidden";
        sub.style.textOverflow = "ellipsis";
        sub.style.whiteSpace = "nowrap";
        t.append(name, sub);
        const usable = e.options.filter((o) => o.kind === "web" || o.supported);
        const b = button(installed.has(e.name) ? "Added" : "Add", "small", () => {
          const option = usable[0];
          if (!option) return;
          if (option.inputs.length === 0) void install(e, option, {});
          else showInputs(e, option);
        });
        b.disabled = installed.has(e.name) || usable.length === 0;
        row.append(t, b);
        results.append(row);
      }
    };
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), 200);
    });
    search.focus();
    void run();
  };

  const install = async (e: CatalogEntry, option: CatalogOption, values: Record<string, string>) => {
    say(`Adding ${e.title}…`);
    try {
      const r = await call<{ added: Added }>("install", { name: e.name, optionId: option.id, values });
      formSlot.textContent = "";
      await finish([r.added]);
    } catch (x) {
      say((x as Error).message, true);
    }
  };

  const showInputs = (e: CatalogEntry, option: CatalogOption) => {
    formSlot.textContent = "";
    const f = el("form", "inline-form");
    f.append(el("strong", "", e.title));
    const inputs = new Map<string, HTMLInputElement>();
    for (const i of option.inputs) {
      const l = el("label", "field-label");
      const input = el("input", i.secret ? "field mono" : "field");
      if (i.secret) input.type = "password";
      input.placeholder = i.placeholder ?? i.default ?? "";
      inputs.set(i.key, input);
      l.append(el("span", "", i.required ? i.label : `${i.label} (optional)`), input);
      f.append(l);
    }
    const acts = el("div", "row gap end");
    acts.append(button("Cancel", "small", () => (formSlot.textContent = "")));
    const submit = el("button", "primary small", "Add");
    submit.type = "submit";
    acts.append(submit);
    f.append(acts);
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const values: Record<string, string> = {};
      for (const [k, input] of inputs) if (input.value.trim()) values[k] = input.value.trim();
      const missing = option.inputs.find((i) => i.required && !values[i.key] && i.default === undefined);
      if (missing) return say(`${missing.label} is needed.`, true);
      void install(e, option, values);
    });
    formSlot.append(f);
    inputs.values().next().value?.focus();
  };

  /** Servers set up in other tools on this computer: Add brings one into this folder. */
  const drawFound = async () => {
    const r = await call<{ found?: Array<{ key: string; source: string; name: string; summary: string; envNames: string[]; scope: string }> }>("found").catch(() => ({ found: [] }));
    foundSlot.textContent = "";
    const found = r.found ?? [];
    if (!found.length) return;
    foundSlot.append(el("div", "eyebrow", "FOUND ON THIS COMPUTER"));
    const box = el("div", "card-plain list");
    for (const f of found) {
      const row = el("div", "setting");
      const t = el("div", "col grow");
      const name = el("span", "");
      name.append(el("strong", "", f.name), el("span", "muted small", ` · ${f.source}${f.scope === "folder" ? ", this folder" : ""}`));
      const sub = el("span", "muted small mono", [f.summary, f.envNames.length ? f.envNames.join(", ") : ""].filter(Boolean).join(" · "));
      sub.title = f.summary;
      sub.style.overflow = "hidden";
      sub.style.textOverflow = "ellipsis";
      sub.style.whiteSpace = "nowrap";
      t.append(name, sub);
      const add = button("Add", "small", async () => {
        add.disabled = true;
        add.textContent = "Adding…";
        try {
          await call("import", { key: f.key });
          await load();
        } catch (x) {
          add.disabled = false;
          add.textContent = "Add";
          sub.textContent = (x as Error).message;
          sub.classList.add("bad");
        }
      });
      row.append(t, add);
      box.append(row);
    }
    foundSlot.append(box);
  };

  const draw = () => {
    list.textContent = "";
    if (servers.length) list.append(el("div", "eyebrow", "ON THIS COMPUTER"));
    else list.append(el("div", "empty-note", "None on this computer yet."));
    for (const s of servers) {
      const h = health.get(s.id);
      const status = !s.enabled ? "off" : h === "checking" || !h ? "checking" : h.ok ? "ok" : h.needsOAuth ? "signin" : "bad";
      const card = el("div", `mcp-card ${status}`);
      const head = el("div", "mcp-card__head");
      const label = el("button", "mcp-card__name");
      label.type = "button";
      label.addEventListener("click", () => {
        if (open.has(s.id)) open.delete(s.id);
        else open.add(s.id);
        draw();
      });
      const t = tools.get(s.id);
      const sub =
        status === "off"
          ? "Off"
          : status === "checking"
            ? "Checking…"
            : status === "signin"
              ? "Needs you to sign in"
              : status === "bad"
                ? `Couldn't connect${typeof h === "object" && h.error ? `: ${h.error}` : ""}`
                : `${t?.length ?? 0} tool${t?.length === 1 ? "" : "s"}`;
      label.append(el("span", "dot"), mcpIcon({ serverName: s.name }, s.name), el("span", "grow"));
      label.lastElementChild!.append(el("strong", "", s.name), el("span", "mcp-card__sub", sub));
      head.append(label);
      if (status === "signin") {
        head.append(
          button("Sign in", "small", async () => {
            await call("oauth", { id: s.id }).catch(() => {});
            void test(s);
          }),
        );
      }
      head.append(
        toggle(s.enabled, `${s.name} on`, async (on) => {
          await call("set", { id: s.id, enabled: on }).catch(() => {});
          s.enabled = on;
          if (on) void test(s);
          else draw();
        }),
      );
      card.append(head);
      if (open.has(s.id) || confirming === s.id) {
        const more = el("div", "mcp-card__more");
        if (t?.length) {
          const names = el("div", "tool-tags");
          for (const x of t.slice(0, 12)) names.append(el("span", "tag mono", x.name));
          if (t.length > 12) names.append(el("span", "muted small", `+${t.length - 12}`));
          more.append(names);
        }
        const acts = el("div", "row gap small");
        if (confirming === s.id) {
          acts.append(
            el("span", "bad", `Remove ${s.name}?`),
            button("Remove", "deny-solid small", async () => {
              await call("remove", { id: s.id }).catch(() => {});
              confirming = null;
              await load();
            }),
            button("Keep", "small", () => {
              confirming = null;
              draw();
            }),
          );
        } else {
          acts.append(
            button("Test", "link small", () => void test(s)),
            button("Remove", "link small bad", () => {
              confirming = s.id;
              draw();
            }),
          );
        }
        more.append(acts);
        card.append(more);
      }
      list.append(card);
    }
  };

  /** Add your own: a URL, a command, or an mcpServers config from another tool. */
  const showForm = () => {
    formSlot.textContent = "";
    const f = el("form", "inline-form");
    const text = el("textarea", "field mono");
    text.rows = 3;
    text.placeholder = "A URL, a command, or an mcpServers config";
    const err = el("div", "bad small hidden");
    const acts = el("div", "row gap end");
    acts.append(button("Cancel", "small", () => (formSlot.textContent = "")));
    const submit = el("button", "primary small", "Add");
    submit.type = "submit";
    acts.append(submit);
    f.append(el("strong", "", "Add a server"), text, err, acts);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const value = text.value.trim();
      if (!value) return;
      submit.disabled = true;
      try {
        const out = await call<{ added: Added[]; failed: Array<{ name: string; error: string }>; skipped: Array<{ name: string; reason: string }> }>("paste", { text: value });
        if (!out.added.length) throw new Error(out.failed[0]?.error ?? (out.skipped[0] ? `Skipped ${out.skipped[0].name}: ${out.skipped[0].reason}.` : "Nothing was added."));
        formSlot.textContent = "";
        if (out.failed.length) say(out.failed.map((x) => `${x.name}: ${x.error}`).join(" · "), true);
        await finish(out.added);
      } catch (x) {
        submit.disabled = false;
        err.textContent = (x as Error).message;
        err.classList.remove("hidden");
      }
    });
    formSlot.append(f);
    text.focus();
  };

    // Another surface (the CLI, the app) may have changed the servers: look
  // again when this view comes back into focus (QA).
  const gen = String(Date.now() + Math.random());
  page.dataset.mcpView = gen;
  const refresh = () => {
    if (!page.isConnected || page.dataset.mcpView !== gen) {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      return;
    }
    void load();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") refresh();
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", onVisible);

  await load();
}
