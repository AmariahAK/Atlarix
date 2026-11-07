/**
 * The model picker: search, Favourites (★ to add or remove), Recent, Atlarix,
 * then one group per provider with whether its key works. A provider whose key
 * was rejected shows "Replace key" instead of models that would fail. Thinking
 * (Normal / Deep) when the model has it, and Models & keys at the foot.
 *
 * Also used by Settings to choose the Plan model (`choose` mode).
 */
import { filterGroups } from "../logic";
import { post, rpc } from "../rpc";
import { rejectedProviders, state } from "../state";
import { button, el, icon, segmented, toggle } from "../ui";

export const picker = el("div", "picker hidden");
picker.setAttribute("role", "dialog");
picker.setAttribute("aria-label", "Pick a model");

interface Options {
  /** The value shown ticked. */
  current: string;
  onChoose(value: string): void;
  /** The chat's own picker: thinking, favourites and Models & keys. */
  full: boolean;
  /** Extra first row ("Same as the chat model"). */
  noneLabel?: string;
}

let opts: Options | null = null;
let query = "";
let index = 0;
let openKeysScreen: (providerId?: string) => void = () => {};

export function initPicker(keys: (providerId?: string) => void): void {
  openKeysScreen = keys;
}

const search = el("input", "picker__search");
search.placeholder = "Search models";
search.setAttribute("aria-label", "Search models");
const list = el("div", "picker__list");
list.setAttribute("role", "listbox");
const foot = el("div", "picker__foot");
picker.append(search, list, foot);

export function pickerOpen(): boolean {
  return !picker.classList.contains("hidden");
}

export function openPicker(o: Options): void {
  if (!state.modelGroups.length) return;
  opts = o;
  query = "";
  search.value = "";
  picker.classList.remove("hidden");
  render(true);
  search.focus();
}

export function closePicker(): void {
  picker.classList.add("hidden");
  opts = null;
}

function items(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(".picker__item")];
}

function highlight(i: number, scroll = true): void {
  items().forEach((x, j) => x.classList.toggle("active", j === i));
  if (scroll) items()[i]?.scrollIntoView({ block: "nearest" });
}

export function renderPicker(): void {
  if (pickerOpen()) render();
}

function render(scrollToCurrent = false): void {
  if (!opts) return;
  list.textContent = "";
  const rejected = rejectedProviders();
  const favs = new Set(state.modelGroups.find((g) => g.group === "favorites")?.options.map((o) => o.value) ?? []);
  if (opts.noneLabel) list.append(row({ value: "", name: opts.noneLabel }, false));
  const groups = filterGroups(state.modelGroups, query);
  for (const g of groups) {
    const provider = g.group;
    const keyed = state.providers?.some((p) => p.id === provider && p.hasKey);
    const head = el("div", "picker__group");
    if (keyed) head.append(el("span", `dot ${rejected.has(provider) ? "bad" : "ok"}`));
    head.append(el("span", "", g.name.toUpperCase()));
    if (rejected.has(provider)) head.append(el("span", "picker__group-note bad", "key rejected"));
    list.append(head);
    if (rejected.has(provider) && !query) {
      const note = el("div", "picker__note");
      note.append(
        el("span", "", `${g.options.length} model${g.options.length === 1 ? "" : "s"}, hidden until the key works.`),
        button("Replace key", "link small", () => {
          closePicker();
          openKeysScreen(provider);
        }),
      );
      list.append(note);
      continue;
    }
    for (const o of g.options) list.append(row(o, favs.has(o.value)));
  }
  if (!groups.length) list.append(el("div", "picker__empty", "No model matches. Add a provider's key for more."));
  const all = items();
  const cur = all.findIndex((i) => i.classList.contains("current"));
  index = query || cur < 0 ? 0 : cur;
  highlight(index, scrollToCurrent);

  foot.textContent = "";
  if (opts.full && state.thinking) {
    const t = el("div", "picker__thinking");
    t.append(
      el("span", "muted", "Effort"),
      segmented(state.thinking.options, state.thinking.value, "Effort", (v) => {
        post({ type: "set-option", configId: "thinking", value: v });
        if (state.thinking) state.thinking.value = v;
        render();
      }),
    );
    foot.append(t);
  }
  if (opts.full && state.computerUse) {
    const cu = state.computerUse;
    const r = el("div", "picker__thinking");
    r.append(el("span", "muted grow", "Computer use"));
    if (cu.why) r.append(el("span", "muted small", cu.why));
    else
      r.append(
        toggle(cu.on, "Computer use", (on) => {
          post({ type: "set-option", configId: "computer_use", value: on ? "on" : "off" });
          if (state.computerUse) state.computerUse.on = on;
        }),
      );
    foot.append(r);
    if (cu.note) foot.append(el("div", "muted small", cu.note));
  }
  if (opts.full) {
    const connected = state.providers?.filter((p) => p.hasKey).length ?? 0;
    const keys = button("", "picker__keys", () => {
      closePicker();
      openKeysScreen();
    });
    keys.innerHTML = icon("key", 14);
    keys.append(el("span", "grow", "Models & keys…"), el("span", "muted small", connected ? `${connected} connected` : ""));
    foot.append(keys);
  }
}

function row(o: { value: string; name: string; description?: string | null }, fav: boolean): HTMLElement {
  const current = o.value === opts!.current;
  const item = button("", `picker__item${current ? " current" : ""}`, () => choose(o.value));
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", String(current));
  const check = el("span", "picker__check");
  if (current) check.innerHTML = icon("check", 13);
  item.append(check, el("span", "picker__name", o.name));
  const desc = o.description ?? "";
  // The tag ACP puts first: "Free" (Auto) or "Uses credit" (a paid row on an
  // account with nothing to pay with), shown as a badge, muted for credit.
  if (/^Free\b/.test(desc)) item.append(el("span", "badge", "Free"));
  else if (/^Uses credit\b/.test(desc)) item.append(el("span", "badge badge--muted", "Credit"));
  const rest = desc.replace(/^(Free|Uses credit)( · )?/, "");
  if (rest) item.append(el("span", "picker__desc", rest));
  if (opts!.full && o.value) {
    const star = button("", `star${fav ? " on" : ""}`, (e) => {
      e.stopPropagation();
      void rpc("_atlarix/favorite", { model: o.value, on: !fav });
    }, fav ? `Remove ${o.name} from favourites` : `Add ${o.name} to favourites`);
    star.innerHTML = icon("star", 13, fav ? ' fill="currentColor"' : "");
    item.append(star);
  }
  return item;
}

function choose(value: string): void {
  const o = opts;
  closePicker();
  o?.onChoose(value);
}

search.addEventListener("input", () => {
  query = search.value;
  render();
});
search.addEventListener("keydown", (e) => {
  const all = items();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    index = Math.max(0, Math.min(all.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
    highlight(index);
  } else if (e.key === "Enter") {
    e.preventDefault();
    all[index]?.click();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePicker();
  }
});
