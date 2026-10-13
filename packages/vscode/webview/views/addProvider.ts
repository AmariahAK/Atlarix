/**
 * Add a provider: search them all, or pick a popular one; its key goes in a
 * form right here (checked before it's saved). Or your own OpenAI-compatible
 * endpoint, or a model server on this computer.
 */
import type { ProviderRow } from "../../src/protocol";
import { matchProviders, SUGGESTED_PROVIDERS } from "../logic";
import { RpcError, rpc } from "../rpc";
import { loadProviders } from "../state";
import { button, el, eyebrow, icon, initials, pageHeader } from "../ui";
import type { Nav } from "./nav";
import { keyForm } from "./provider";
import { KEYS_NOTE } from "./settings";

const BLURB: Record<string, string> = {
  anthropic: "Claude models",
  openai: "GPT and o-series",
  google: "Gemini models",
  openrouter: "Many labs, one key",
  deepseek: "DeepSeek models",
  xai: "Grok models",
  groq: "Fast open models",
  mistral: "Mistral and Codestral",
};

export async function renderAddProvider(page: HTMLElement, nav: Nav, focus?: string): Promise<void> {
  page.textContent = "";
  page.append(pageHeader("Add a provider", () => nav.back()));
  const body = el("div", "page__body");
  page.append(body);
  const providers = await loadProviders();
  let query = "";
  let chosen: ProviderRow | null = focus ? (providers.find((p) => p.id === focus) ?? null) : null;
  /** Which page of every provider is showing (A–Z, PAGE at a time). */
  let pageNo = 0;
  const PAGE = 20;
  let custom = false;

  const search = el("input", "field");
  search.type = "search";
  search.placeholder = "Search providers";
  search.setAttribute("aria-label", "Search providers");
  const slot = el("div", "");
  body.append(search, slot);

  const draw = () => {
    slot.textContent = "";
    if (chosen) {
      const card = el("section", "card-plain");
      const head = el("div", "row gap");
      head.append(el("span", "prov__badge", initials(chosen.name)), el("strong", "grow", chosen.name), button("Cancel", "link small", () => {
        chosen = null;
        draw();
      }));
      card.append(head, keyForm(chosen, () => nav.go({ name: "provider", id: chosen!.id })));
      slot.append(card);
    }
    if (query.trim()) {
      const hits = matchProviders(providers, query, 40);
      const list = el("div", "pick-list");
      for (const p of hits) list.append(pickRow(p));
      if (!hits.length) list.append(el("div", "empty-note", "No provider by that name. Your own endpoint works too, below."));
      slot.append(list);
    } else {
      slot.append(eyebrow("POPULAR"));
      const grid = el("div", "pop-grid");
      for (const id of SUGGESTED_PROVIDERS) {
        const p = providers.find((x) => x.id === id);
        if (!p) continue;
        if (p.hasKey) {
          const done = el("div", "pop done");
          const name = el("strong", "row gap", p.name);
          name.insertAdjacentHTML("beforeend", icon("check", 12));
          done.append(name, el("span", "ok small", "Connected"));
          grid.append(done);
        } else {
          const b = button("", "pop", () => choose(p));
          b.append(el("strong", "", p.name), el("span", "muted small", BLURB[id] ?? ""));
          grid.append(b);
        }
      }
      slot.append(grid);
    }
    slot.append(eyebrow("YOUR OWN"));
    if (custom) slot.append(customForm(nav, () => ((custom = false), draw())));
    else {
      const own = button("", "pick-row", () => ((custom = true), draw()));
      own.innerHTML = icon("code", 15);
      const t = el("span", "col grow");
      t.append(el("strong", "", "OpenAI-compatible endpoint"), el("span", "muted small", "A gateway or proxy: base URL, key, models"));
      own.append(t);
      slot.append(own);
    }
    const local = el("div", "pick-row static");
    local.innerHTML = icon("monitor", 15);
    const lt = el("span", "col grow");
    lt.append(el("strong", "", "On this computer"), el("span", "muted small", "Ollama and LM Studio appear on their own while running"));
    local.append(lt);
    slot.append(local);
    if (!query.trim()) {
      // Every provider, A–Z, a page at a time, each with how many models it
      // offers; open one to see them before adding a key (owner: "show every
      // provider, and the models inside").
      const all = [...providers].filter((x) => !x.custom).sort((a, b) => a.name.localeCompare(b.name));
      const pages = Math.max(1, Math.ceil(all.length / PAGE));
      pageNo = Math.min(pageNo, pages - 1);
      const head = el("div", "row between");
      head.append(eyebrow(`EVERY PROVIDER · ${all.length}`), el("span", "muted small", `${pageNo * PAGE + 1}–${Math.min(all.length, (pageNo + 1) * PAGE)} of ${all.length}`));
      slot.append(head);
      const list = el("div", "pick-list");
      for (const p of all.slice(pageNo * PAGE, (pageNo + 1) * PAGE)) list.append(pickRow(p));
      slot.append(list);
      const pager = el("div", "pager");
      const prev = button("← Previous", "small", () => ((pageNo -= 1), draw(), list.scrollIntoView({ block: "start" })));
      const next = button("Next →", "small", () => ((pageNo += 1), draw(), list.scrollIntoView({ block: "start" })));
      prev.disabled = pageNo === 0;
      next.disabled = pageNo >= pages - 1;
      pager.append(prev, el("span", "muted small", `Page ${pageNo + 1} of ${pages}`), next);
      slot.append(pager);
    }
    slot.append(el("p", "foot-note", KEYS_NOTE));
  };

  const pickRow = (p: ProviderRow) => {
    const b = button("", "pick-row", () => nav.go({ name: "provider", id: p.id }));
    const t = el("span", "col grow");
    t.append(el("span", "", p.name));
    if (p.catalogModels) t.append(el("span", "muted small", `${p.catalogModels} model${p.catalogModels === 1 ? "" : "s"}`));
    b.append(el("span", "prov__badge", initials(p.name)), t);
    b.append(p.hasKey ? el("span", "ok small", "Connected") : el("span", "muted small", "View ›"));
    return b;
  };
  const choose = (p: ProviderRow) => {
    if (p.hasKey) return nav.go({ name: "provider", id: p.id });
    chosen = p;
    query = "";
    search.value = "";
    draw();
    slot.scrollIntoView({ block: "start" });
  };

  search.addEventListener("input", () => {
    query = search.value;
    draw();
  });
  draw();
  if (!chosen) search.focus();
}

/** Your own endpoint: name, base URL, key; models come from the endpoint, else ask for one. */
function customForm(nav: Nav, cancel: () => void): HTMLElement {
  const f = el("form", "inline-form");
  const field = (label: string, input: HTMLInputElement) => {
    const l = el("label", "field-label");
    l.append(el("span", "", label), input);
    return l;
  };
  const name = el("input", "field");
  name.placeholder = "My gateway";
  const base = el("input", "field mono");
  base.placeholder = "https://api.example.com/v1";
  const key = el("input", "field mono");
  key.type = "password";
  key.autocomplete = "off";
  const model = el("input", "field mono");
  model.placeholder = "model-id";
  const modelLabel = field("Model id (the endpoint didn't list its models)", model);
  modelLabel.classList.add("hidden");
  const err = el("div", "bad small hidden");
  const acts = el("div", "row gap end");
  const submit = el("button", "primary small", "Add");
  submit.type = "submit";
  acts.append(button("Cancel", "small", cancel), submit);
  key.placeholder = "leave empty if it needs none";
  f.append(el("strong", "", "OpenAI-compatible endpoint"), field("Name", name), field("Base URL, up to /v1", base), field("API key", key), modelLabel, err, acts);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!name.value.trim() || !base.value.trim()) {
      err.textContent = "A name and a base URL are needed.";
      err.classList.remove("hidden");
      return;
    }
    submit.disabled = true;
    submit.textContent = "Connecting…";
    err.classList.add("hidden");
    try {
      const r = await rpc<{ id: string; models: number }>("_atlarix/provider_custom", {
        name: name.value.trim(),
        baseUrl: base.value.trim(),
        key: key.value.trim(),
        ...(model.value.trim() ? { models: [model.value.trim()] } : {}),
      });
      await loadProviders(true);
      nav.go({ name: "provider", id: r.id });
    } catch (x) {
      const needsModel = (x as RpcError).data && ((x as RpcError).data as { needsModel?: boolean }).needsModel;
      if (needsModel) modelLabel.classList.remove("hidden");
      err.textContent = (x as Error).message;
      err.classList.remove("hidden");
      submit.disabled = false;
      submit.textContent = "Add";
    }
  });
  setTimeout(() => name.focus(), 0);
  return f;
}
