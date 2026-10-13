/**
 * Past chats: search; this folder's, every folder's, or the starred ones;
 * newest or oldest first, grouped by day; rename and delete in place, and ★.
 */
import { dayGroup } from "../logic";
import { expectSession } from "../chat/composer";
import { post, rpc } from "../rpc";
import { state } from "../state";
import { button, el, icon, MODE_NAME, pageHeader, relTime } from "../ui";
import type { Nav } from "./nav";

interface Row {
  sessionId: string;
  title: string | null;
  updatedAt: string;
  mode: string | null;
  starred: boolean;
  folder?: string;
  folderName?: string;
}

let scope: "here" | "all" | "starred" = "here";
let sort: "newest" | "oldest" = "newest";
let query = "";

export async function renderHistory(page: HTMLElement, nav: Nav): Promise<void> {
  page.textContent = "";
  page.append(pageHeader("Past chats", () => nav.back()));
  const tools = el("div", "history__tools");
  const search = el("input", "field");
  search.type = "search";
  search.placeholder = "Search chats";
  search.setAttribute("aria-label", "Search chats");
  search.value = query;
  const filters = el("div", "history__filters");
  const list = el("div", "history__list");
  tools.append(search, filters);
  page.append(tools, list);

  let rows: Row[] = [];
  const load = async () => {
    list.textContent = "";
    list.append(el("div", "muted pad", "Loading…"));
    const r = await rpc<{ sessions: Row[] }>("_atlarix/sessions", scope === "all" ? { all: true } : { cwd: state.workspace }).catch(() => ({ sessions: [] }));
    rows = r.sessions;
    draw();
  };

  const drawFilters = () => {
    filters.textContent = "";
    for (const [k, label] of [
      ["here", "This folder"],
      ["all", "All folders"],
      ["starred", "Starred"],
    ] as const) {
      const b = button(label, `filter${scope === k ? " on" : ""}`, () => {
        const reload = (k === "all") !== (scope === "all");
        scope = k;
        drawFilters();
        if (reload) void load();
        else draw();
      });
      b.setAttribute("aria-pressed", String(scope === k));
      filters.append(b);
    }
    filters.append(el("span", "grow"));
    const sel = el("select", "select-sm");
    sel.setAttribute("aria-label", "Sort");
    for (const [v, n] of [
      ["newest", "Newest"],
      ["oldest", "Oldest"],
    ] as const) {
      const o = el("option", "", n);
      o.value = v;
      sel.append(o);
    }
    sel.value = sort;
    sel.addEventListener("change", () => {
      sort = sel.value as typeof sort;
      draw();
    });
    filters.append(sel);
  };

  const draw = () => {
    list.textContent = "";
    const q = query.trim().toLowerCase();
    let shown = rows.filter((r) => (scope !== "starred" || r.starred) && (!q || (r.title ?? "untitled").toLowerCase().includes(q)));
    shown = [...shown].sort((a, b) => (sort === "newest" ? 1 : -1) * (new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
    if (!rows.length) return void list.append(el("div", "empty-note", scope === "all" ? "No chats yet." : "No past chats in this folder yet."));
    if (!shown.length) return void list.append(el("div", "empty-note", scope === "starred" ? "Star a chat to keep it here." : "No chat matches."));
    let group = "";
    for (const r of shown) {
      const g = dayGroup(r.updatedAt);
      if (g !== group) {
        group = g;
        list.append(el("div", "eyebrow", g.toUpperCase()));
      }
      list.append(row(r));
    }
  };

  const row = (r: Row): HTMLElement => {
    const item = el("div", `hrow${r.sessionId === state.sessionId ? " current" : ""}`);
    const open = button("", "hrow__open", () => {
      post({ type: "load-session", sessionId: r.sessionId, ...(r.folder ? { folder: r.folder } : {}) });
      nav.back();
    });
    const meta = [r.mode ? (MODE_NAME[r.mode] ?? r.mode) : "", relTime(r.updatedAt), scope === "all" && r.folderName ? r.folderName : ""].filter(Boolean).join(" · ");
    open.append(el("span", "hrow__title", r.title || "Untitled"), el("span", "hrow__meta", meta));
    const acts = el("div", "hrow__acts");
    const rename = button("", "icon small", () => editName(), "Rename");
    rename.innerHTML = icon("pencil", 13);
    const del = button("", "icon small", () => confirmDelete(), "Delete");
    del.innerHTML = icon("trash", 13);
    const star = button("", `icon small star${r.starred ? " on" : ""}`, async () => {
      r.starred = !r.starred;
      await rpc("_atlarix/star", { sessionId: r.sessionId, on: r.starred }).catch(() => (r.starred = !r.starred));
      draw();
    }, r.starred ? "Unstar" : "Star");
    star.innerHTML = icon("star", 13, r.starred ? ' fill="currentColor"' : "");
    acts.append(rename, del, star);
    item.append(open, acts);

    const editName = () => {
      item.textContent = "";
      item.classList.add("editing");
      const field = el("input", "field");
      field.value = r.title ?? "";
      field.setAttribute("aria-label", "Chat name");
      const save = async () => {
        const t = field.value.trim();
        if (t && t !== r.title) {
          await rpc("_atlarix/session", { sessionId: r.sessionId, action: "rename", title: t }).catch(() => {});
          r.title = t;
        }
        draw();
      };
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void save();
        else if (e.key === "Escape") draw();
      });
      item.append(field, button("Save", "primary small", () => void save()));
      field.focus();
      field.select();
    };
    const confirmDelete = () => {
      item.textContent = "";
      item.classList.add("danger");
      const body = el("div", "hrow__confirm");
      body.append(
        el("span", "hrow__title", r.title || "Untitled"),
        el("span", "grow"),
        el("span", "bad small", "Delete this chat?"),
        button("Delete", "deny-solid small", async () => {
          await rpc("_atlarix/session", { sessionId: r.sessionId, action: "delete" }).catch(() => {});
          rows = rows.filter((x) => x.sessionId !== r.sessionId);
          if (r.sessionId === state.sessionId) (expectSession(), post({ type: "new-chat" }));
          draw();
        }),
        button("Keep", "small", () => draw()),
      );
      item.append(body);
    };
    return item;
  };

  search.addEventListener("input", () => {
    query = search.value;
    draw();
  });
  drawFilters();
  await load();
  if (rows.length > 6) search.focus();
}

/** /undo: your messages, newest first; choosing one goes back to it. */
export async function renderUndo(page: HTMLElement, nav: Nav, goBack: (id: number, text: string) => void): Promise<void> {
  page.textContent = "";
  page.append(pageHeader("Go back to a message", () => nav.back()));
  page.append(el("p", "muted pad", "Edit it and send it again; everything after it is replaced."));
  const list = el("div", "history__list");
  page.append(list);
  const r = await rpc<{ messages: Array<{ id: number; text: string }> }>("_atlarix/undo", { sessionId: state.sessionId, action: "list" }).catch(() => ({ messages: [] }));
  if (!r.messages.length) list.append(el("div", "empty-note", "Nothing to go back to yet."));
  r.messages.forEach((m, i) => {
    const first = m.text.split("\n")[0] ?? "";
    const b = button("", "hrow__open", () => {
      nav.back();
      goBack(m.id, m.text);
    });
    b.append(el("span", "hrow__title", first.length > 90 ? `${first.slice(0, 89)}…` : first), el("span", "hrow__meta", i === 0 ? "latest" : `${i} back`));
    const item = el("div", "hrow");
    item.append(b);
    list.append(item);
  });
}
