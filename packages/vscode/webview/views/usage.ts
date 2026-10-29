/**
 * Usage: your activity on this computer (tiles, half a year's calendar,
 * favourite models and modes, skills, MCP), Atlarix credits, tokens per day by
 * model with filters, MCP and skill calls per day, and which models Atlarix Auto
 * answered with. All local (lib/stats via the agent) except Credits, which is
 * the account's. The share card is drawn here and saved by the extension.
 */
import type { UsageCredits } from "@/lib/stats/usage-types";
import type { UsageReport } from "@/lib/stats/usage-types";
import { post, rpc } from "../rpc";
import { el, eyebrow, money, pageHeader, button, tokens } from "../ui";
import type { Nav } from "./nav";

type Tab = "overview" | "credits" | "tokens" | "tools" | "auto";
const TABS: Array<[Tab, string]> = [
  ["overview", "Overview"],
  ["credits", "Credits"],
  ["tokens", "Tokens"],
  ["tools", "MCP & Skills"],
  ["auto", "Auto"],
];

interface Overview {
  empty: boolean;
  tiles: Array<{ label: string; value: string }>;
  sections: Array<{ title: string; rows: Array<{ label: string; value: string }> }>;
  footnote: string;
}

interface UsageReply {
  report: UsageReport;
  overview: Overview;
  shareSvg: string | null;
}

/** What this page asked for last, so a tab switch keeps the filters. */
let filters: { days?: number; model?: string; surface?: string; source?: string } = {};

export async function renderUsage(page: HTMLElement, nav: Nav, tab: Tab = "overview"): Promise<void> {
  page.textContent = "";
  page.append(pageHeader("Usage", () => nav.back()));
  const tabs = el("nav", "tabs");
  tabs.setAttribute("aria-label", "Usage sections");
  for (const [id, name] of TABS) {
    const t = button(name, `tab${id === tab ? " on" : ""}`, () => void renderUsage(page, nav, id));
    if (id === tab) t.setAttribute("aria-current", "page");
    tabs.append(t);
  }
  const body = el("div", "page__body usage");
  body.append(el("div", "muted pad", "Loading…"));
  page.append(tabs, body);
  if (tab === "credits") {
    const r = await rpc<{ credits: UsageCredits }>("_atlarix/usage_credits", {}).catch(() => null);
    body.textContent = "";
    return creditsTab(body, r?.credits ?? { state: "unavailable" });
  }
  const r = await rpc<UsageReply>("_atlarix/usage", filters).catch(() => null);
  body.textContent = "";
  if (!r) return void body.append(el("div", "error", "Couldn't read usage."));
  if (tab === "overview") overviewTab(body, r);
  else if (tab === "tokens") tokensTab(body, r.report, () => void renderUsage(page, nav, "tokens"));
  else if (tab === "tools") toolsTab(body, r.report);
  else autoTab(body, r.report);
}

/** Stacked columns, one a day, scaled to the busiest day; `title` says what a column holds. */
function columns(days: Array<{ day: string; values: number[] }>, title: (d: { day: string; values: number[] }) => string): HTMLElement {
  const max = Math.max(0, ...days.map((d) => d.values.reduce((a, b) => a + b, 0)));
  const chart = el("div", "use-bars");
  for (const d of days) {
    const total = d.values.reduce((a, b) => a + b, 0);
    const col = el("div", "use-bars__day");
    col.title = title(d);
    if (max > 0 && total > 0) {
      const stack = el("div", "use-bars__stack");
      stack.style.height = `${Math.max(2, (total / max) * 100)}%`;
      d.values.forEach((v, i) => {
        if (v <= 0) return;
        const seg = el("span", `use-bars__seg ser${Math.min(i, 5)}`);
        seg.style.flexGrow = String(v);
        stack.append(seg);
      });
      col.append(stack);
    }
    chart.append(col);
  }
  return chart;
}

function legend(labels: string[]): HTMLElement {
  const l = el("div", "use-legend small");
  labels.forEach((name, i) => {
    const item = el("span", "use-legend__item");
    item.append(el("span", `use-legend__dot ser${Math.min(i, 5)}`), el("span", "", name));
    l.append(item);
  });
  return l;
}

const shortDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

function overviewTab(body: HTMLElement, r: UsageReply): void {
  const o = r.overview;
  if (o.empty) return void body.append(el("div", "muted pad", "No activity yet."));
  const grid = el("div", "stat-grid");
  for (const t of o.tiles) {
    const s = el("div", "stat");
    s.append(el("span", "muted small", t.label), el("strong", "mono", t.value));
    grid.append(s);
  }
  // Half a year fits the sidebar.
  const weeks = r.report.overview.weeks.slice(-26);
  const labels = r.report.overview.monthLabels.slice(-26);
  const cal = el("div", "act-cal");
  const months = el("div", "act-cal__months");
  for (const m of labels) months.append(el("span", "", m ?? ""));
  const cols = el("div", "act-cal__weeks");
  for (const w of weeks) {
    const col = el("div", "act-cal__week");
    for (const d of w) {
      const cell = el("span", `act-cal__day l${d.inRange ? d.level : "x"}`);
      if (d.inRange) cell.title = `${d.day}: ${d.turns} ${d.turns === 1 ? "turn" : "turns"}`;
      col.append(cell);
    }
    cols.append(col);
  }
  cal.append(months, cols);
  const share = r.shareSvg;
  const head = el("div", "row between");
  head.append(eyebrow("YOUR ACTIVITY"), ...(share ? [button("Save share card", "link small", () => void saveCard(share))] : []));
  body.append(head, grid, cal);
  for (const sec of o.sections) {
    const box = el("div", "act-sec");
    box.append(el("strong", "small", sec.title));
    for (const row of sec.rows) {
      const line = el("div", "row between small");
      line.append(el("span", "act-sec__label", row.label), el("span", "muted mono", row.value));
      box.append(line);
    }
    body.append(box);
  }
  body.append(el("div", "muted small", o.footnote));
}

/** The card as a PNG, through a canvas; the extension asks where to save it. */
async function saveCard(svg: string): Promise<void> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1200;
  canvas.height = img.naturalHeight || 630;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  post({ type: "save-image", name: `atlarix-usage-${new Date().toISOString().slice(0, 10)}.png`, dataUrl: canvas.toDataURL("image/png") });
}

function select(label: string, value: string | null, options: Array<{ key: string; label: string }>, all: string, onPick: (v: string | undefined) => void): HTMLElement {
  const s = el("select", "use-filter small");
  s.setAttribute("aria-label", label);
  s.append(new Option(all, ""));
  for (const o of options) s.append(new Option(o.label, o.key, false, o.key === value));
  s.onchange = () => onPick(s.value || undefined);
  return s;
}

function tokensTab(body: HTMLElement, r: UsageReport, redraw: () => void): void {
  if (!r.tokens.since) return void body.append(el("div", "muted pad", "Tokens are counted from your next chat."));
  const f = el("div", "use-filters");
  const set = (k: keyof typeof filters) => (v: string | number | undefined) => {
    filters = { ...filters, [k]: v };
    redraw();
  };
  f.append(
    select("Range", String(r.range), [{ key: "30", label: "30 days" }, { key: "90", label: "90 days" }, { key: "365", label: "12 months" }], "30 days", (v) =>
      set("days")(v ? Number(v) : undefined),
    ),
    select("Model", r.filters.applied.model, r.filters.models, "All models", set("model")),
    select("Surface", r.filters.applied.surface, r.filters.surfaces, "Everywhere", set("surface")),
    select("Source", r.filters.applied.source, r.filters.sources, "All sources", set("source")),
  );
  const total = el("strong", "mono", `${tokens(r.tokens.total)} tokens`);
  body.append(
    f,
    total,
    columns(r.tokens.byDay, (d) => `${shortDay(d.day)}: ${tokens(d.values.reduce((a, b) => a + b, 0))}`),
    legend(r.tokens.series.map((s) => s.label)),
  );
  if (r.byok) {
    const box = el("div", "act-sec");
    box.append(
      el("strong", "small", `Your own keys: about $${r.byok.totalUsd.toFixed(2)}`),
      el(
        "span",
        "muted small",
        `An estimate at list price, not a bill: ${r.byok.pricedTurns} turns from ${r.byok.since}` +
          (r.byok.unpricedTurns > 0 ? `; ${r.byok.unpricedTurns} on models without a reliable price are left out.` : "."),
      ),
    );
    body.append(box);
  }
  body.append(el("div", "muted small", `Tokens are counted from ${r.tokens.since}.`));
}

function toolsTab(body: HTMLElement, r: UsageReport): void {
  if (!r.tools.byDay.some((d) => d.mcp + d.skill > 0)) {
    return void body.append(el("div", "muted pad", `No MCP or skill calls in the last ${r.range} days.`));
  }
  body.append(
    columns(
      r.tools.byDay.map((d) => ({ day: d.day, values: [d.mcp, d.skill] })),
      (d) => `${shortDay(d.day)}: ${d.values[0]} MCP, ${d.values[1]} skills`,
    ),
    legend(["MCP", "Skills"]),
  );
  for (const [title, list, unit] of [
    ["MCP servers", r.tools.mcp, "call"],
    ["Skills", r.tools.skills, "run"],
  ] as const) {
    if (!list.length) continue;
    const box = el("div", "act-sec");
    box.append(el("strong", "small", title));
    for (const x of list) {
      const line = el("div", "row between small");
      line.append(el("span", "act-sec__label", x.name), el("span", "muted mono", `${x.runs} ${unit}${x.runs === 1 ? "" : "s"}`));
      box.append(line);
    }
    body.append(box);
  }
}

function autoTab(body: HTMLElement, r: UsageReport): void {
  if (r.autoPicks.steps === 0) return void body.append(el("div", "muted pad", "Atlarix Auto hasn't answered yet."));
  const zenith = r.autoPicks.models.some((m) => m.tier === "zenith");
  body.append(
    columns(
      r.autoPicks.byDay.map((d) => ({ day: d.day, values: [d.paid, d.free] })),
      (d) => `${shortDay(d.day)}: ${d.values[0]} paid, ${d.values[1]} free`,
    ),
    legend(["Paid", "Free"]),
  );
  const box = el("div", "act-sec");
  box.append(el("strong", "small", `${r.autoPicks.steps} steps`));
  for (const m of r.autoPicks.models) {
    const line = el("div", "row between small");
    const where = `${zenith ? `${m.tier === "zenith" ? "Zenith" : "Auto"}, ` : ""}${m.billing}`;
    line.append(el("span", "act-sec__label", `${m.label} · ${where}`), el("span", "muted mono", `${m.share}%`));
    box.append(line);
  }
  body.append(box, el("div", "muted small", `Which model answered each Auto step, from ${r.autoPicks.since}.`));
}

function creditsTab(body: HTMLElement, c: UsageCredits): void {
  if (c.state === "signed_out") return void body.append(el("div", "muted pad", "Sign in to see Atlarix credits."));
  if (c.state === "unavailable") return void body.append(el("div", "muted pad", "Credits can't be read right now."));
  const grid = el("div", "stat-grid");
  const stat = (k: string, v: string) => {
    const s = el("div", "stat");
    s.append(el("span", "muted small", k), el("strong", "mono", v));
    grid.append(s);
  };
  stat("Balance", money(c.balanceCents));
  if (c.plan === "pro" && c.grantedTotalCents > 0) {
    stat("Pro allowance used", `${money(c.grantedTotalCents - c.grantedCents)} of ${money(c.grantedTotalCents)}`);
    if (c.renewsAt) stat("Resets", new Date(c.renewsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  }
  body.append(grid);
  const recent = c.days.slice(-30);
  const spent = c.days.reduce((n, d) => n + d.autoPaidCents + d.coreCents + d.toolCents + d.otherCents + d.unsplitCents, 0);
  if (spent === 0) return void body.append(el("div", "muted pad", "No Atlarix credit used yet."));
  const hasOther = recent.some((d) => d.toolCents + d.otherCents > 0);
  const hasUnsplit = recent.some((d) => d.unsplitCents > 0);
  body.append(
    eyebrow("SPENT · LAST 30 DAYS"),
    columns(
      recent.map((d) => ({ day: d.day, values: [d.autoPaidCents, d.coreCents, d.toolCents + d.otherCents, d.unsplitCents] })),
      (d) => `${shortDay(d.day)}: ${money(d.values.reduce((a, b) => a + b, 0))}`,
    ),
    legend(["Auto", "Core", ...(hasOther || hasUnsplit ? ["Search, reviewer, cloud"] : []), ...(hasUnsplit ? ["Earlier, not split"] : [])]),
  );
}
