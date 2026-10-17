/**
 * The chat's building blocks: elements, buttons, our stroke icons and Rix, a
 * switch, and the small formatters every screen uses. Vanilla DOM; model output
 * never goes through innerHTML (only our own SVG does).
 */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function button(label: string, cls: string, onClick: (e: MouseEvent) => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  b.addEventListener("click", onClick);
  return b;
}

/** Our icons: 16px strokes in currentColor (Lucide-like, drawn for Atlarix). */
const PATHS: Record<string, string> = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  history: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  server: '<rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><path d="M5 5h.01M5 11h.01"/>',
  user: '<circle cx="8" cy="6" r="2.5"/><path d="M3.5 13c.8-2.2 2.6-3.2 4.5-3.2s3.7 1 4.5 3.2"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  at: '<circle cx="8" cy="8" r="2.5"/><path d="M10.5 8v1a1.8 1.8 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M14 11l-3.5-3.5L4 13"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  down: '<path d="M4 6l4 4 4-4"/>',
  chevUp: '<path d="M4 10l4-4 4 4"/>',
  right: '<path d="M6 3l5 5-5 5"/>',
  back: '<path d="M10 3L5 8l5 5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  key: '<circle cx="5" cy="8" r="3"/><path d="M8 8h6.5M12 8v2.5M14.5 8v2"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5"/>',
  compact: '<path d="M3 6h10M5 10h6M8 1.5v3M6.5 3L8 4.5 9.5 3M8 14.5v-3M6.5 13L8 11.5 9.5 13"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  file: '<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/>',
  folder: '<path d="M1.5 4.5h4l1.5 1.5h7.5v7.5h-13z"/>',
  pencil: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  warn: '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5h.01"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  monitor: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5.5 14h5M8 11v3"/>',
  code: '<path d="M6 4L2 8l4 4M10 4l4 4-4 4"/>',
  link: '<path d="M6.5 9.5l3-3M5 11l-1 1a2.1 2.1 0 0 1-3-3l2.5-2.5a2.1 2.1 0 0 1 3 0M11 5l1-1a2.1 2.1 0 0 1 3 3l-2.5 2.5a2.1 2.1 0 0 1-3 0"/>',
  git: '<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="7" r="1.5"/><path d="M5 5.5v5M11 8.5c0 2-6 1-6 2"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10.5h2.5"/>',
  bolt: '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>',
  external: '<path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/>',
};

export function icon(name: keyof typeof PATHS | string, size = 16, extra = ""): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${PATHS[name] ?? ""}</svg>`;
}

/** An icon-only button with a label for screen readers. */
export function iconButton(name: string, label: string, onClick: (e: MouseEvent) => void, cls = "icon"): HTMLButtonElement {
  const b = button("", cls, onClick, label);
  b.innerHTML = icon(name);
  return b;
}

/** Rix's glyph (assets/rix/rix-glyph.svg), in Atlarix emerald by default. */
export function rixGlyph(size: number, color = "var(--primary)"): string {
  const w = size >= 48 ? 0.7 : 1.2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4.6" cy="8.6" r="3.4" stroke-width="${w * 1.1}"/><path d="M4.6 5.2v6.8M1.4 8.6c2 .7 4.4.7 6.4 0" stroke-width="${w * 0.75}"/><ellipse cx="9.6" cy="8.2" rx="1.6" ry="1.3" stroke-width="${w}"/><circle cx="12.6" cy="7" r="1.7" stroke-width="${w}"/><path d="M13.2 5.4l1.1-2.4M12.9 2.4h2.6" stroke-width="${w * 0.9}"/><path d="M8.6 9.4l-1.4 3.6M9.8 9.6l.4 3.4M11 9.2l1.6 3.4" stroke-width="${w * 0.8}"/></svg>`;
}

/** An on/off switch: a real checkbox (keyboard and screen readers) drawn as a switch. */
export function toggle(on: boolean, label: string, onChange: (on: boolean) => void): HTMLLabelElement {
  const wrap = el("label", "switch");
  const input = el("input");
  input.type = "checkbox";
  input.checked = on;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked));
  wrap.append(input, el("span", "switch__track"));
  return wrap;
}

/** A row of choices, one selected (Normal / Deep). */
export function segmented(
  options: Array<{ value: string; name: string; description?: string | null }>,
  value: string,
  label: string,
  onPick: (v: string) => void,
): HTMLElement {
  const g = el("div", "seg");
  g.setAttribute("role", "radiogroup");
  g.setAttribute("aria-label", label);
  for (const o of options) {
    // The model's default level is marked (dotted underline, "default" on hover),
    // so it is clear why no level shows beside the model (QA).
    const isDefault = o.description === "default";
    const b = button(o.name, `seg__opt${o.value === value ? " on" : ""}${isDefault ? " seg__opt--default" : ""}`, () => onPick(o.value));
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(o.value === value));
    if (isDefault) b.title = "default";
    g.append(b);
  }
  return g;
}

/** A section label: small caps, muted. */
export function eyebrow(text: string): HTMLElement {
  return el("div", "eyebrow", text);
}

export const money = (cents: number | null | undefined) =>
  cents == null ? "—" : (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });

export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "just now", "5 min ago", "2h ago", "Yesterday", "Oct 9". */
export function relTime(iso: string | number | Date): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The mode's name as the picker says it. */
export const MODE_NAME: Record<string, string> = { build: "Build", ask: "Explore", plan: "Plan", debug: "Debug", review: "Review" };

/** The page header for a screen: ← back, a title, and optional actions on the right. */
export function pageHeader(title: string, onBack: () => void, ...actions: HTMLElement[]): HTMLElement {
  const h = el("header", "page__head");
  const back = iconButton("back", "Back", onBack, "icon back");
  h.append(back, el("h1", "page__title", title), ...actions);
  return h;
}

/** A provider's initials, for its badge ("DeepSeek" → "DS", "OpenAI" → "OA"). */
export function initials(name: string): string {
  const words = name.replace(/\(.*?\)/g, "").trim().split(/[\s-]+/).filter(Boolean);
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const caps = name.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps.slice(0, 2).join("");
  return name.slice(0, 2).toUpperCase();
}
