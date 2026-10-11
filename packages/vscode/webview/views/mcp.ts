/**
 * MCP servers in this folder: each one's state (tested when the screen opens),
 * its tools, on/off, Test, Remove, and Sign in for one that needs it; Add opens
 * a form right here.
 */
import { rpc } from "../rpc";
import { state } from "../state";
import { button, el, pageHeader, toggle } from "../ui";
import type { Nav } from "./nav";

interface Server {
  id: number;
  name: string;
  transport: string;
  enabled: boolean;
}
type Health = { ok: boolean; error?: string; needsOAuth?: boolean } | "checking";

export async function renderMcp(page: HTMLElement, nav: Nav): Promise<void> {
  page.textContent = "";
  const add = button("Add", "primary small", () => showForm());
  page.append(pageHeader("MCP servers", () => nav.back(), add));
  const body = el("div", "page__body");
  const list = el("div", "mcp__list");
  const formSlot = el("div", "");
  const foundSlot = el("div", "");
  body.append(el("p", "muted small", "Tools Atlarix can use in this folder, shared with the Atlarix app and CLI."), list, formSlot, foundSlot);
  page.append(body);

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
    void drawFound();
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
    if (!servers.length) list.append(el("div", "empty-note", "None yet. Add one to give Atlarix more tools."));
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
      label.append(el("span", "dot"), el("span", "grow"));
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

  const showForm = () => {
    formSlot.textContent = "";
    const f = el("form", "inline-form");
    const name = el("input", "field");
    name.placeholder = "github";
    const target = el("input", "field mono");
    target.placeholder = "npx -y @modelcontextprotocol/server-github, or https://…";
    const err = el("div", "bad small hidden");
    const field = (label: string, input: HTMLInputElement) => {
      const l = el("label", "field-label");
      l.append(el("span", "", label), input);
      return l;
    };
    const acts = el("div", "row gap end");
    acts.append(button("Cancel", "small", () => (formSlot.textContent = "")));
    const submit = el("button", "primary small", "Add and test");
    submit.type = "submit";
    acts.append(submit);
    f.append(el("strong", "", "Add a server"), field("Name", name), field("Command or URL", target), err, acts);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const n = name.value.trim();
      const t = target.value.trim();
      if (!n || !t) return;
      const isUrl = /^https?:\/\//i.test(t);
      try {
        await call("add", { name: n, ...(isUrl ? { url: t } : { command: t }) });
        formSlot.textContent = "";
        await load();
      } catch (x) {
        err.textContent = (x as Error).message;
        err.classList.remove("hidden");
      }
    });
    formSlot.append(f);
    name.focus();
  };

  await load();
}
