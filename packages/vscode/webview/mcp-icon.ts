/**
 * An MCP server's logo, as in the app: Atlarix fetches and checks it and hands
 * back a data: URL, which is only ever an <img>. Until then, or with none
 * found, the first letter of its title.
 */
import { rpc } from "./rpc";
import { state } from "./state";
import { el } from "./ui";

export type McpIconRef = { name?: string; url?: string; serverName?: string };

const cache = new Map<string, Promise<string | null>>();

export function mcpIcon(ref: McpIconRef, title: string, size = 22): HTMLElement {
  const box = el("span", "mcp-icon", (title.trim()[0] ?? "?").toUpperCase());
  box.style.width = box.style.height = `${size}px`;
  box.style.fontSize = `${Math.max(10, Math.round(size * 0.45))}px`;
  box.setAttribute("aria-hidden", "true");
  const key = JSON.stringify(ref);
  let p = cache.get(key);
  if (!p) {
    p = rpc<{ icon?: string | null }>("_atlarix/mcp", { sessionId: state.sessionId, action: "icon", ...ref })
      .then((r) => (typeof r.icon === "string" && r.icon.startsWith("data:image/") ? r.icon : null))
      .catch(() => null);
    cache.set(key, p);
  }
  void p.then((src) => {
    if (!src) return;
    const img = el("img", "mcp-icon mcp-icon--img");
    img.src = src;
    img.alt = "";
    img.draggable = false;
    img.style.width = img.style.height = `${size}px`;
    box.replaceWith(img);
  });
  return box;
}
