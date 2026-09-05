/**
 * Turn the driver's `structuredContent.elements` into the text a model reads.
 *
 * Field names taken from `cua-driver describe get_window_state`, which documents the
 * structured side as one entry per indexed row with `element_index`, `role`,
 * `label`, `value`, `frame: {x,y,w,h}`, `parent_index`, `depth`, plus the
 * `element_token` documented on `click`. The markdown (`tree_markdown`) is
 * explicitly back-compat only — "new fields will only be added to the structured
 * side" — so we parse `elements` and ignore the prose.
 *
 * # Why this trims at all
 *
 * The driver's own default ceiling is ~2000 elements at depth 25, and its
 * description names the reason: "Electron / Obsidian / large web apps that produce
 * 10k+ element trees". Two thousand rows is a fine ceiling for a driver and a
 * catastrophe for a prompt — the whole point of tier 1 is a few hundred tokens. So
 * the walk is bounded on the way IN (via `max_elements`) and the result is trimmed
 * again here, interactive-first.
 */
import type { DesktopElement } from "./refs";

/** One row of the driver's structured payload. */
export interface DriverElement {
  element_index?: number;
  element_token?: string;
  role?: string;
  label?: string;
  value?: string;
  frame?: { x?: number; y?: number; w?: number; h?: number };
  parent_index?: number;
  depth?: number;
}

export interface WindowSnapshot {
  elements?: DriverElement[];
  tree_markdown?: string;
  element_count?: number;
  filtered_element_count?: number;
  window_bounds?: { x?: number; y?: number; w?: number; h?: number };
  screenshot_scale?: number;
  app_name?: string;
  window_title?: string;
  /** Set when the window is live but its AX surface could not be resolved. */
  degraded_reason?: string;
}

/**
 * Roles worth acting on. Deliberately generous — a role we do not recognise is
 * still listed if it has a label, because the alternative is hiding a control the
 * user can plainly see.
 */
const INTERACTIVE = new RegExp(
  [
    "button", "checkbox", "radio", "menu", "menuitem", "tab", "link", "textfield",
    "textarea", "combobox", "popupbutton", "slider", "stepper", "switch", "toggle",
    "cell", "row", "list", "table", "outline", "disclosure", "segment", "search",
    "incrementor", "colorwell", "datepicker",
  ].join("|"),
  "i",
);

/** A frame that cannot be clicked, whatever the tree claims. */
function isActionable(el: DriverElement): boolean {
  const f = el.frame ?? {};
  const w = Number(f.w ?? 0);
  const h = Number(f.h ?? 0);
  // The driver warns about "virtualized off-viewport rows with `h:1` frames" — a
  // row that exists in the tree and is not on screen. Acting on one does nothing
  // visible, so it must not be offered as a ref.
  if (w <= 1 || h <= 1) return false;
  return true;
}

function labelFor(el: DriverElement): string {
  const label = (el.label ?? "").trim();
  if (label) return label;
  const value = (el.value ?? "").trim();
  // A field with no label but a value is still identifiable by what it holds.
  if (value) return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return "";
}

export interface ParsedWindow {
  /** Ready for `mintRefs` — everything except the ref itself. */
  elements: Array<Omit<DesktopElement, "ref">>;
  /** How many the driver reported before our trim. */
  total: number;
  /** True when the AX surface could not be resolved at all. */
  degraded: boolean;
  degradedReason?: string;
  appName?: string;
  windowTitle?: string;
}

export function parseWindowSnapshot(
  snap: WindowSnapshot,
  opts?: { interactiveOnly?: boolean; max?: number },
): ParsedWindow {
  const interactiveOnly = opts?.interactiveOnly ?? true;
  const max = opts?.max ?? 60;
  const rows = snap.elements ?? [];

  const kept: Array<Omit<DesktopElement, "ref">> = [];
  for (const el of rows) {
    const token = el.element_token;
    // No token, no ref. An `element_index` without its `snapshot_id` is the unsafe
    // primitive — it still resolves after a change, to a different element — so a
    // row we cannot address safely is simply not offered.
    if (!token) continue;
    if (!isActionable(el)) continue;

    const role = (el.role ?? "").trim() || "unknown";
    const label = labelFor(el);
    // Drop unlabelled non-interactive scaffolding: a model cannot act on
    // "AXGroup" with no name, and every such row costs tokens.
    if (interactiveOnly && !label && !INTERACTIVE.test(role)) continue;
    if (!label && !INTERACTIVE.test(role)) continue;

    const f = el.frame ?? {};
    kept.push({
      role,
      label,
      ...(el.value?.trim() ? { value: el.value.trim() } : {}),
      frame: {
        x: Number(f.x ?? 0) || 0,
        y: Number(f.y ?? 0) || 0,
        w: Number(f.w ?? 0) || 0,
        h: Number(f.h ?? 0) || 0,
      },
      depth: Number(el.depth ?? 0) || 0,
      token,
    });
    if (kept.length >= max) break;
  }

  return {
    elements: kept,
    total: Number(snap.element_count ?? rows.length) || rows.length,
    degraded: Boolean(snap.degraded_reason) || rows.length === 0,
    ...(snap.degraded_reason ? { degradedReason: snap.degraded_reason } : {}),
    ...(snap.app_name ? { appName: snap.app_name } : {}),
    ...(snap.window_title ? { windowTitle: snap.window_title } : {}),
  };
}

/**
 * Render the read as the text the model receives.
 *
 * One line per element, and the header carries the two things that prevent the
 * common mistakes: that refs belong to THIS read, and how to act on one.
 */
export function formatWindow(
  parsed: ParsedWindow,
  refs: DesktopElement[],
  app: { name: string; pid: number },
): string {
  if (refs.length === 0) {
    return (
      `No addressable elements in ${app.name}. ` +
      (parsed.degraded
        ? `Its accessibility surface could not be read (${parsed.degradedReason ?? "empty tree"}), ` +
          `which usually means the app draws its own surface. Read it with mode:"text" — ` +
          `local OCR — which is slower and lossy but will see what this tree cannot.`
        : `The window may still be loading; re-read once. If it stays empty the app draws ` +
          `its own surface — use mode:"text" for OCR.`)
    );
  }

  const shown = refs.length;
  const head =
    `${shown} element(s) in ${app.name}` +
    (parsed.windowTitle ? ` — "${parsed.windowTitle}"` : "") +
    (parsed.total > shown ? ` (showing ${shown} of ${parsed.total})` : "") +
    `. Act on any ref with computer (e.g. action:"click", ref:"${refs[0]!.ref}"). ` +
    `Refs are valid for THIS read only — re-read after anything that navigates.`;

  const lines = refs.map((e) => {
    const value = e.value && e.value !== e.label ? ` = ${JSON.stringify(e.value.slice(0, 60))}` : "";
    const indent = "  ".repeat(Math.min(e.depth, 6));
    return `${indent}${e.ref} ${e.role}${e.label ? ` "${e.label}"` : ""}${value}`;
  });

  return `${head}\n${lines.join("\n")}`;
}

/**
 * Rank elements to a plain-words query, for the cheapest read of all.
 *
 * The driver has its own `query` parameter that projects the tree server-side, and
 * that is what `mode:"find"` passes down — this is the local ranking applied to
 * whatever comes back, so "submit button" beats a substring match on "submit".
 */
export function findElements(
  elements: DesktopElement[],
  query: string,
  max = 6,
): DesktopElement[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = elements.map((e) => {
    const hay = `${e.label} ${e.role} ${e.value ?? ""}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (hay.includes(t)) score += 2;
      if (e.label.toLowerCase() === t) score += 5;
      if (e.label.toLowerCase().startsWith(t)) score += 2;
      if (e.role.toLowerCase().includes(t)) score += 1;
    }
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.e);
}
