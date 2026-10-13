/**
 * One provider: its key (masked; Replace checks a new one before saving it;
 * Test again), where its API lives, its models with price, context and what
 * each can do (★ puts one first in the picker), on/off, and Remove key.
 */
import type { KeyStatus, ProviderRow } from "../../src/protocol";
import { RpcError, post, rpc } from "../rpc";
import { checkKey, loadProviders, on, state } from "../state";
import { button, el, icon, initials, pageHeader, relTime, toggle, tokens } from "../ui";
import type { Nav } from "./nav";
import { KEYS_NOTE } from "./settings";

interface ModelInfo {
  value: string;
  name: string;
  id: string;
  context: number | null;
  price: { input: number; output: number } | null;
  tools: boolean;
  thinking: boolean;
  images: boolean;
}

let unsub: (() => void) | null = null;

export async function renderProvider(page: HTMLElement, nav: Nav, id: string): Promise<void> {
  unsub?.();
  const providers = await loadProviders();
  const p = providers.find((x) => x.id === id);
  page.textContent = "";
  if (!p) {
    page.append(pageHeader("Provider", () => nav.back()), el("div", "empty-note", "That provider isn't available any more."));
    return;
  }
  const head = pageHeader(p.name, () => nav.back());
  head.insertBefore(el("span", "prov__badge", initials(p.name)), head.querySelector(".page__title"));
  if (p.hasKey) {
    head.append(
      toggle(!p.off, `${p.name} on`, async (v) => {
        await rpc("_atlarix/provider_enabled", { providerId: p.id, on: v }).catch(() => {});
        await loadProviders(true);
      }),
    );
  }
  const body = el("div", "page__body");
  const keySec = el("section", "sec");
  const modelsSec = el("section", "sec");
  const foot = el("div", "page__foot");
  body.append(keySec, modelsSec);
  if (p.hasKey) body.append(foot);
  page.append(head, body);

  const drawKey = () => {
    keySec.textContent = "";
    const t = el("div", "row between");
    t.append(el("h2", "sec__title", "API key"));
    if (p.keyUrl) t.append(button("Get a key ↗", "link small", () => post({ type: "open-url", url: p.keyUrl! })));
    keySec.append(t);
    if (!p.hasKey) {
      keySec.append(keyForm(p, async () => nav.go({ name: "provider", id: p.id })));
      return;
    }
    const row = el("div", "row gap");
    const masked = el("div", "key-field grow");
    masked.innerHTML = icon("lock", 13);
    masked.append(el("span", "mono", p.keyHint === "none" ? "No key (this server needs none)" : p.keyHint ? p.keyHint.replace("…", "••••••••••••") : "••••"));
    row.append(masked, button("Replace", "small", () => {
      keySec.replaceChildren(keySec.firstChild!, keyForm(p, async () => renderProvider(page, nav, id), true));
    }));
    keySec.append(row);
    const c = state.keyChecks.get(p.id);
    const st = el("div", "row gap small key-status");
    if (c) {
      // "unchecked" is not a pass: the provider lists no models, so nothing was
      // confirmed (a wrong address said "Saved", QA). Its reason shows below.
      const label: Record<KeyStatus | "checking", string> = { works: "Works", rejected: "Key rejected", unchecked: "Not checked", unreachable: "Couldn't reach it", checking: "Checking…" };
      st.append(el("span", `status ${c.status === "works" ? "works" : c.status === "rejected" ? "bad" : "muted"}`, label[c.status]));
      if (c.status !== "checking") st.append(el("span", "muted", `checked ${relTime(c.at)}`));
    }
    st.append(el("span", "grow"), button("Test again", "link small", () => void checkKey(p.id)));
    keySec.append(st);
    if (c && (c.status === "rejected" || c.status === "unreachable") && c.detail) keySec.append(el("div", "bad small", c.detail));
    if (c && c.status === "unchecked" && c.detail) {
      keySec.append(el("div", "muted small", p.custom ? `${c.detail} If it should list them, check the base URL (most end in /v1).` : c.detail));
    }
    if (p.baseUrl) {
      const d = el("details", "small");
      d.open = !!p.custom && !!c && c.status !== "works" && c.status !== "checking";
      d.append(el("summary", "muted", "Base URL"));
      if (p.custom) {
        // Yours to fix: checked before it replaces the old one.
        const f = el("form", "row gap");
        const input = el("input", "field mono grow");
        input.value = p.baseUrl;
        input.setAttribute("aria-label", "Base URL");
        const save = el("button", "small", "Save");
        save.type = "submit";
        const msg = el("div", "small hidden");
        f.append(input, save);
        f.addEventListener("submit", async (e) => {
          e.preventDefault();
          if (input.value.trim() === p.baseUrl) return;
          save.disabled = true;
          msg.className = "small muted";
          msg.textContent = "Checking…";
          try {
            await rpc("_atlarix/provider_base_url", { providerId: p.id, baseUrl: input.value.trim() });
            await loadProviders(true);
            void checkKey(p.id);
            void renderProvider(page, nav, id);
          } catch (x) {
            msg.className = "bad small";
            msg.textContent = (x as Error).message;
            save.disabled = false;
          }
        });
        d.append(f, msg);
      } else d.append(el("div", "key-field mono", p.baseUrl));
      keySec.append(d);
    }
  };

  const drawModels = async () => {
    modelsSec.textContent = "";
    // Shown before a key too, from the catalog: what you'd get (owner).
    const t = el("div", "row between");
    t.append(el("h2", "sec__title", "Models"), el("span", "muted small", p.hasKey ? "Starred ones lead the picker" : "Add a key above to use them"));
    const search = el("input", "field");
    search.type = "search";
    search.placeholder = "Search models by name or id";
    search.setAttribute("aria-label", "Search models");
    const list = el("div", "model-list");
    modelsSec.append(t, search, list);
    list.append(el("div", "muted pad", "Loading…"));
    const r = await rpc<{ models: ModelInfo[]; catalog?: boolean }>("_atlarix/models", { providerId: p.id }).catch(() => ({ models: [] as ModelInfo[], catalog: false }));
    const favs = () => new Set(state.modelGroups.find((g) => g.group === "favorites")?.options.map((o) => o.value) ?? []);
    const draw = () => {
      list.textContent = "";
      const q = search.value.trim().toLowerCase();
      const shown = r.models.filter((m) => !q || `${m.name} ${m.id}`.toLowerCase().includes(q));
      if (!shown.length) list.append(el("div", "empty-note", r.models.length ? "No model matches." : p.hasKey ? "No models listed for this key." : "This provider lists its models once you add a key."));
      const f = favs();
      for (const m of shown.slice(0, 200)) {
        const row = el("div", "model-row");
        const main = el("div", "col grow");
        const name = el("div", "row gap");
        name.append(el("strong", "", m.name));
        if (m.value === state.modelValue) name.append(el("span", "tag ok", "in use"));
        const idBtn = button("", "model-row__id mono", () => post({ type: "copy", text: m.id }), `Copy ${m.id}`);
        idBtn.textContent = [m.id, m.context ? `${tokens(m.context)} context` : "", m.price ? `$${m.price.input} / $${m.price.output} per 1M` : ""].filter(Boolean).join(" · ");
        const tags = el("div", "row gap");
        for (const [on, label] of [
          [m.tools, "Tools"],
          [m.thinking, "Thinking"],
          [m.images, "Images"],
        ] as const)
          if (on) tags.append(el("span", "tag", label));
        main.append(name, idBtn, tags);
        row.append(main);
        // Starring is for models you can use: after a key.
        if (p.hasKey) {
          const fav = f.has(m.value);
          const star = button("", `icon small star${fav ? " on" : ""}`, async () => {
            await rpc("_atlarix/favorite", { model: m.value, on: !fav }).catch(() => {});
          }, fav ? `Unstar ${m.name}` : `Star ${m.name}`);
          star.innerHTML = icon("star", 15, fav ? ' fill="currentColor"' : "");
          row.append(star);
        }
        list.append(row);
      }
    };
    search.addEventListener("input", draw);
    draw();
    // Starring changes the picker's options: redraw the stars.
    unsub = on("options", draw);
  };

  let confirming = false;
  const drawFoot = () => {
    foot.textContent = "";
    if (confirming) {
      foot.append(
        el("span", "bad small grow", `Remove the ${p.name} key?${p.custom ? " This removes the provider too." : ""}`),
        button("Remove", "deny-solid small", async () => {
          await rpc("_atlarix/provider_key", { providerId: p.id, key: null }).catch(() => {});
          state.keyChecks.delete(p.id);
          await loadProviders(true);
          nav.back();
        }),
        button("Keep", "small", () => {
          confirming = false;
          drawFoot();
        }),
      );
      return;
    }
    foot.append(
      el("span", "muted small grow", `Chats on ${p.name} move to Atlarix Auto.`),
      button("Remove key", "deny small", () => {
        confirming = true;
        drawFoot();
      }),
    );
  };

  drawKey();
  void drawModels();
  drawFoot();
  const offKeys = on("keys", drawKey);
  const prev = unsub;
  unsub = () => {
    offKeys();
    prev?.();
  };
  page.append(el("p", "foot-note", KEYS_NOTE));
}

/**
 * Paste a key; Connect checks it with the provider first and saves only a key
 * that isn't rejected. The field is a password field: the key never shows.
 */
export function keyForm(p: ProviderRow, done: () => void | Promise<void>, replacing = false): HTMLElement {
  const f = el("form", "inline-form");
  const label = el("label", "field-label");
  const input = el("input", "field mono");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = replacing ? `A new ${p.name} key` : `Your ${p.name} API key`;
  label.append(el("span", "", "API key"), input);
  const err = el("div", "bad small hidden");
  const acts = el("div", "row gap end");
  const submit = el("button", "primary small", replacing ? "Check and save" : "Connect");
  submit.type = "submit";
  acts.append(el("span", "muted small grow", "Checked before it's saved."), submit);
  f.append(label, err, acts);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    submit.disabled = true;
    submit.textContent = "Checking…";
    err.classList.add("hidden");
    const check = await rpc<{ status: KeyStatus; detail: string }>("_atlarix/provider_test", { providerId: p.id, key }).catch((x: RpcError) => ({
      status: "unreachable" as const,
      detail: x.message,
    }));
    if (check.status === "rejected") {
      err.textContent = `${p.name} rejected that key: ${check.detail}`;
      err.classList.remove("hidden");
      submit.disabled = false;
      submit.textContent = replacing ? "Check and save" : "Connect";
      return;
    }
    try {
      await rpc("_atlarix/provider_key", { providerId: p.id, key });
      state.keyChecks.set(p.id, { status: check.status, detail: check.detail, at: Date.now() });
      input.value = "";
      await loadProviders(true);
      await done();
    } catch (x) {
      err.textContent = (x as Error).message;
      err.classList.remove("hidden");
      submit.disabled = false;
    }
  });
  setTimeout(() => input.focus(), 0);
  return f;
}
