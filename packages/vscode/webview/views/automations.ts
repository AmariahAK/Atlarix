/**
 * Automations in this folder, as the CLI's /automations has them: each one's
 * trigger and last run, on/off, Run now, Edit, Delete, and its recent runs;
 * New opens a form right here. The agent can make them too (its `automations`
 * tool), after you approve.
 */
import { rpc } from "../rpc";
import { state } from "../state";
import { button, el, pageHeader, relTime, toggle } from "../ui";
import type { Nav } from "./nav";

type Trigger =
  | { kind: "schedule"; cron: string; preset?: string }
  | { kind: "mcp"; serverId: number; tool: string; intervalMinutes: number; args?: unknown };

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  prompt: string;
  runMode: "notify-only" | "read-only";
  notifyAgent: boolean;
  model: { provider: string; name: string } | null;
  lastRunAt: number | null;
}

interface Run {
  id: string;
  automationId: string;
  status: "running" | "ok" | "nothing-to-report" | "error";
  summary: string | null;
  error: string | null;
  unread: boolean;
  startedAt: number;
}

type Draft = Omit<Automation, "id" | "lastRunAt">;

const PRESETS = [
  { key: "hourly", label: "Hourly", cron: "0 * * * *" },
  { key: "daily", label: "Daily (9am)", cron: "0 9 * * *" },
  { key: "weekly", label: "Weekly (Mon 9am)", cron: "0 9 * * 1" },
  { key: "weekday-mornings", label: "Weekday mornings", cron: "0 9 * * 1-5" },
];

export function describeTrigger(t: Trigger): string {
  if (t.kind === "mcp") return `checks ${t.tool} every ${t.intervalMinutes} min`;
  return PRESETS.find((p) => p.cron === t.cron)?.label.toLowerCase() ?? `cron ${t.cron}`;
}

const RUN_MARK: Record<Run["status"], string> = { ok: "✓", "nothing-to-report": "–", error: "✗", running: "…" };

export async function renderAutomations(page: HTMLElement, nav: Nav, onSeen: () => void): Promise<void> {
  page.textContent = "";
  const add = button("New", "primary small", () => showForm(null));
  page.append(pageHeader("Automations", () => nav.back(), add));
  const body = el("div", "page__body");
  const list = el("div", "mcp__list");
  const formSlot = el("div", "");
  const scope = button("", "link small", async () => {
    all = !all;
    await load();
  });
  const intro = el("p", "muted small", "Scheduled and triggered tasks. They run while Atlarix (the app, the CLI or this editor) is open. You can also ask Atlarix to set one up. ");
  intro.append(scope);
  body.append(intro, formSlot, list);
  page.append(body);

  const call = <T>(action: string, extra: Record<string, unknown> = {}) =>
    rpc<T>("_atlarix/automations", { sessionId: state.sessionId, action, all, ...extra });
  let all = false;
  let items: Automation[] = [];
  let runs: Run[] = [];
  const open = new Set<string>();
  let confirming: string | null = null;
  let note: { id: string; text: string; bad?: boolean } | null = null;

  const apply = (r: { automations?: Automation[]; runs?: Run[] }) => {
    items = r.automations ?? [];
    runs = r.runs ?? [];
    draw();
  };
  const load = async () => {
    scope.textContent = all ? "Show this folder's" : "Show every folder's";
    apply(await call<{ automations?: Automation[]; runs?: Run[] }>("list").catch(() => ({})));
  };
  const act = async (id: string, action: string, extra: Record<string, unknown> = {}, done?: string) => {
    try {
      apply(await call<{ automations?: Automation[]; runs?: Run[] }>(action, { id, ...extra }));
      note = done ? { id, text: done } : null;
    } catch (x) {
      note = { id, text: (x as Error).message, bad: true };
    }
    draw();
  };

  const draw = () => {
    list.textContent = "";
    if (!items.length) {
      list.append(el("div", "empty-note", all ? "No automations in any folder yet." : "None in this folder yet. New makes one, or ask Atlarix, e.g. “check the tests every morning”."));
    }
    for (const a of items) {
      const mine = runs.filter((r) => r.automationId === a.id);
      const unread = mine.filter((r) => r.unread).length;
      const card = el("div", `mcp-card auto-card ${a.enabled ? "auto-card--on" : "off"}`);
      const head = el("div", "mcp-card__head");
      const label = el("button", "mcp-card__name");
      label.type = "button";
      label.addEventListener("click", () => {
        if (open.has(a.id)) open.delete(a.id);
        else {
          open.add(a.id);
          const ids = mine.filter((r) => r.unread).map((r) => r.id);
          if (ids.length) {
            for (const r of mine) r.unread = false;
            void call("read", { runIds: ids }).catch(() => {});
          }
        }
        draw();
      });
      const sub = [describeTrigger(a.trigger), a.lastRunAt ? `last ran ${relTime(a.lastRunAt)}` : "not run yet"].join(" · ");
      const text = el("span", "grow");
      const name = el("strong", "", a.name);
      text.append(name, el("span", "mcp-card__sub", sub));
      if (unread) name.append(el("span", "auto-card__new", `${unread} new`));
      label.append(el("span", "dot"), text);
      head.append(
        label,
        toggle(a.enabled, `${a.name} on`, (on) => void act(a.id, "toggle", { enabled: on }, on ? "On." : "Off.")),
      );
      card.append(head);

      if (open.has(a.id) || confirming === a.id || note?.id === a.id) {
        const more = el("div", "mcp-card__more");
        const what =
          a.runMode === "read-only"
            ? `Atlarix runs a read-only task: “${a.prompt}”`
            : "Just tells you when it fires (no model, no tokens).";
        more.append(
          el("div", "small", what),
          el("div", "muted small", a.notifyAgent ? "Results go to you, and Atlarix wakes up with them to act." : "Results go to you only."),
        );
        if (mine.length) {
          const r = el("div", "auto-runs");
          for (const run of mine.slice(0, 5)) {
            const row = el("div", `auto-run auto-run--${run.status}`);
            const line = (run.error ?? run.summary ?? (run.status === "nothing-to-report" ? "Nothing to report" : run.status === "running" ? "Running…" : "Done")).split("\n")[0]!.replace(/`/g, "");
            row.append(el("span", "auto-run__mark", RUN_MARK[run.status] ?? "·"), el("span", "auto-run__when muted", relTime(run.startedAt)), el("span", "auto-run__text", line));
            row.title = run.error ?? run.summary ?? "";
            r.append(row);
          }
          more.append(r);
        }
        const acts = el("div", "row gap small");
        if (confirming === a.id) {
          acts.append(
            el("span", "bad", `Delete ${a.name}?`),
            button("Delete", "deny-solid small", async () => {
              confirming = null;
              open.delete(a.id);
              await act(a.id, "remove");
            }),
            button("Keep", "small", () => {
              confirming = null;
              draw();
            }),
          );
        } else {
          acts.append(
            button("Run now", "link small", () => void act(a.id, "run", {}, "Running now. The result shows here when it's done.")),
            button("Edit", "link small", () => showForm(a)),
            button("Delete", "link small bad", () => {
              confirming = a.id;
              draw();
            }),
          );
        }
        more.append(acts);
        if (note?.id === a.id) more.append(el("div", note.bad ? "bad small" : "muted small", note.text));
        card.append(more);
      }
      list.append(card);
    }
  };

  const showForm = (existing: Automation | null) => {
    const draft: Draft = existing
      ? { name: existing.name, enabled: existing.enabled, trigger: existing.trigger, prompt: existing.prompt, runMode: existing.runMode, notifyAgent: existing.notifyAgent, model: existing.model }
      : { name: "", enabled: true, trigger: { kind: "schedule", cron: "0 9 * * *", preset: "daily" }, prompt: "", runMode: "read-only", notifyAgent: false, model: null };
    formSlot.textContent = "";
    const f = el("form", "inline-form");
    const field = (label: string, input: HTMLElement, hint?: string) => {
      const l = el("label", "field-label");
      l.append(el("span", "", label), input);
      if (hint) l.append(el("span", "muted small", hint));
      return l;
    };
    const select = (options: Array<[string, string]>, value: string) => {
      const s = el("select", "field");
      for (const [v, t] of options) {
        const o = el("option", "", t);
        o.value = v;
        s.append(o);
      }
      s.value = value;
      return s;
    };

    const name = el("input", "field");
    name.placeholder = "Tests every morning";
    name.value = draft.name;

    const t = draft.trigger;
    const whenValue = t.kind === "mcp" ? "mcp" : PRESETS.find((p) => p.cron === t.cron)?.key ?? "cron";
    const when = select([...PRESETS.map((p) => [p.key, p.label] as [string, string]), ["cron", "Custom schedule (cron)"], ["mcp", "When something changes in an MCP server"]], whenValue);
    const cron = el("input", "field mono");
    cron.placeholder = "30 8 * * 1-5";
    cron.value = t.kind === "schedule" ? t.cron : "";
    const cronRow = field("Cron", cron, "minute hour day month weekday, e.g. 30 8 * * 1-5 = weekdays at 8:30");

    const server = el("select", "field");
    const tool = el("select", "field");
    const every = el("input", "field");
    every.type = "number";
    every.min = "5";
    every.value = t.kind === "mcp" ? String(t.intervalMinutes) : "15";
    const mcpRows = el("div", "col gap");
    mcpRows.append(field("MCP server", server), field("Tool", tool, "Called on every check; a change in its answer fires the automation."), field("Check every (minutes, 5 or more)", every));
    const loadTools = async () => {
      tool.textContent = "";
      const r = await call<{ tools?: Array<{ name: string }> }>("tools", { serverId: Number(server.value) }).catch(() => ({ tools: [] }));
      for (const x of r.tools ?? []) {
        const o = el("option", "", x.name);
        o.value = x.name;
        tool.append(o);
      }
      if (t.kind === "mcp") tool.value = t.tool;
    };
    server.addEventListener("change", () => void loadTools());
    const loadServers = async () => {
      if (server.options.length) return;
      const r = await call<{ servers?: Array<{ id: number; name: string }> }>("servers").catch(() => ({ servers: [] }));
      if (!r.servers?.length) {
        const o = el("option", "", "No MCP servers in this folder");
        o.value = "";
        server.append(o);
        return;
      }
      for (const s of r.servers) {
        const o = el("option", "", s.name);
        o.value = String(s.id);
        server.append(o);
      }
      if (t.kind === "mcp") server.value = String(t.serverId);
      await loadTools();
    };

    const mode = select(
      [
        ["read-only", "Atlarix runs a task (read-only: it looks, runs checks, reports)"],
        ["notify-only", "Just tell me (no model, no tokens)"],
      ],
      draft.runMode,
    );
    const prompt = el("textarea", "field");
    prompt.rows = 3;
    prompt.placeholder = "Run the tests and tell me what fails.";
    prompt.value = draft.prompt;
    const promptRow = field("What should Atlarix do each time?", prompt);
    const who = select(
      [
        ["user", "Just me (costs no tokens in chat)"],
        ["agent", "Me and Atlarix (it wakes up with the result to act: tests, CI)"],
      ],
      draft.notifyAgent ? "agent" : "user",
    );

    const sync = () => {
      cronRow.classList.toggle("hidden", when.value !== "cron");
      mcpRows.classList.toggle("hidden", when.value !== "mcp");
      promptRow.classList.toggle("hidden", mode.value !== "read-only");
      if (when.value === "mcp") void loadServers();
    };
    when.addEventListener("change", sync);
    mode.addEventListener("change", sync);

    const err = el("div", "bad small hidden");
    const acts = el("div", "row gap end");
    acts.append(button("Cancel", "small", () => (formSlot.textContent = "")));
    const submit = el("button", "primary small", existing ? "Save" : "Create");
    submit.type = "submit";
    acts.append(submit);
    f.append(
      el("strong", "", existing ? `Edit “${existing.name}”` : "New automation"),
      field("Name", name),
      field("When does it run?", when),
      cronRow,
      mcpRows,
      field("When it fires", mode),
      promptRow,
      field("Who hears about it?", who),
      err,
      acts,
    );
    sync();

    const fail = (text: string) => {
      err.textContent = text;
      err.classList.remove("hidden");
    };
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      draft.name = name.value.trim().slice(0, 120);
      if (!draft.name) return fail("Give it a name.");
      const preset = PRESETS.find((p) => p.key === when.value);
      if (preset) draft.trigger = { kind: "schedule", cron: preset.cron, preset: preset.key };
      else if (when.value === "cron") {
        if (cron.value.trim().split(/\s+/).length !== 5) return fail("A cron line has five fields: minute hour day month weekday.");
        draft.trigger = { kind: "schedule", cron: cron.value.trim() };
      } else {
        const n = Number(every.value);
        if (!server.value) return fail("Add an MCP server to this folder first (MCP servers page).");
        if (!tool.value) return fail("Pick the tool to check.");
        if (!Number.isInteger(n) || n < 5) return fail("Check every 5 minutes or more, in whole minutes.");
        draft.trigger = { kind: "mcp", serverId: Number(server.value), tool: tool.value, intervalMinutes: n };
      }
      draft.runMode = mode.value as Draft["runMode"];
      draft.prompt = prompt.value.trim();
      if (draft.runMode === "read-only" && !draft.prompt) return fail("Say what it should do each time.");
      draft.notifyAgent = who.value === "agent";
      submit.disabled = true;
      try {
        apply(await call(existing ? "update" : "create", existing ? { id: existing.id, draft } : { draft }));
        formSlot.textContent = "";
      } catch (x) {
        submit.disabled = false;
        fail(`Couldn't save: ${(x as Error).message}`);
      }
    });
    formSlot.append(f);
    name.focus();
  };

  await load();
  onSeen();
}
