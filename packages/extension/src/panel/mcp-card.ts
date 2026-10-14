/**
 * The card `mcp_servers` suggest draws: "Recommended for you", the server, why
 * Atlarix wants it, and Connect. Connecting adds it to the account (where every
 * Atlarix surface sees it), runs the sign-in in a tab or takes a key, switches
 * it on, and sends "Connected …" as the user's next message, which is what the
 * agent was told to expect.
 */
import { coreProxyFetch } from "../core/client";
import { api } from "../shared/browser-api";
import {
  accountRpc,
  connectorNaming,
  connectorRows,
  findRegistryServer,
  probeAuth,
  webEntry,
  type ConnectorRowLite,
} from "../tools/mcp-servers";

export interface McpCardArgs {
  server: string;
  reason?: string;
}

/** The suggestion in a recorded call, or null when it isn't one. */
export function mcpSuggestionFromArgs(raw: string): McpCardArgs | null {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    if (a.operation !== "suggest" || typeof a.server !== "string" || !a.server.trim()) return null;
    return { server: a.server.trim(), ...(typeof a.reason === "string" ? { reason: a.reason } : {}) };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildMcpCard(args: McpCardArgs, deps: { send(text: string): void }): HTMLElement {
  const card = document.createElement("div");
  card.className = "mcp-card";
  const head = document.createElement("div");
  head.className = "mcp-card__head";
  head.textContent = "Recommended for you";
  const title = document.createElement("div");
  title.className = "mcp-card__title";
  title.textContent = args.server;
  const sub = document.createElement("p");
  sub.className = "mcp-card__note";
  sub.textContent = args.reason ?? "";
  const key = document.createElement("input");
  key.type = "password";
  key.className = "mcp-card__key";
  key.hidden = true;
  const status = document.createElement("p");
  status.className = "mcp-card__status";
  const actions = document.createElement("div");
  actions.className = "grant__actions";
  const connect = document.createElement("button");
  connect.type = "button";
  connect.className = "button grant__allow";
  connect.textContent = "Connect";
  const later = document.createElement("button");
  later.type = "button";
  later.className = "button";
  later.textContent = "Not now";
  actions.append(connect, later);
  card.append(head, title, sub, key, status, actions);

  let display = args.server;
  let url: string | null = null;
  let header: string | null = null;
  let registryName: string | null = null;
  let row: ConnectorRowLite | undefined;

  void (async () => {
    const rows = (await connectorRows()) ?? [];
    row = rows.find((r) => r.registry_name === args.server || r.name.toLowerCase() === args.server.toLowerCase());
    if (row) {
      display = row.name;
      url = row.url;
    } else {
      const server = await findRegistryServer(args.server);
      const entry = server ? webEntry(server) : null;
      if (entry) {
        display = entry.title;
        registryName = entry.name;
        const web = entry.options.find((o) => o.kind === "web") as { url: string; inputs: Array<{ key: string; label: string }> };
        url = web.url;
        const h = web.inputs.find((i) => i.key.startsWith("header:"));
        if (h) header = h.key.slice("header:".length);
        title.textContent = entry.verified ? `${entry.title} · ✓ Verified` : `${entry.title} · ${entry.publisher}`;
        if (!sub.textContent) sub.textContent = entry.description;
      } else {
        status.textContent = "This server can't be added from here.";
        connect.disabled = true;
      }
    }
    if (row) title.textContent = row.name;
    if (header) {
      key.hidden = false;
      key.placeholder = header;
    }
  })();

  later.addEventListener("click", () => {
    card.remove();
    deps.send(`Not now for ${display}.`);
  });

  connect.addEventListener("click", () => {
    void (async () => {
      connect.disabled = true;
      later.disabled = true;
      try {
        let id = row?.id ?? null;
        let authType = row?.auth_type ?? null;
        if (!id) {
          if (!url) throw new Error("No address to connect to.");
          if (header && !key.value.trim()) {
            key.focus();
            throw new Error(`${header} is needed.`);
          }
          authType = header ? "header" : await probeAuth(url);
          const { name, slug } = connectorNaming(display);
          const saved = await accountRpc("upsert_account_mcp_server", {
            id: null,
            name,
            slug,
            url,
            auth_type: authType,
            ...(header ? { auth_header: header } : {}),
            ...(registryName ? { registry_name: registryName } : {}),
          });
          id = String(saved.id);
        }
        if ((authType === "header" || authType === "api_key") && !row?.credential_set_at) {
          if (!key.value.trim()) {
            key.hidden = false;
            key.placeholder = header ?? "API key";
            key.focus();
            throw new Error("Paste its key, then Connect.");
          }
          await coreProxyFetch(`/connectors/${encodeURIComponent(id)}/credential`, { api_key: key.value.trim() });
        }
        if (authType === "oauth" && !row?.credential_set_at) {
          const r = await coreProxyFetch<{ authorization_url?: string; error?: string }>(
            `/connectors/${encodeURIComponent(id)}/authorize`,
            { return: "app" },
          );
          if (!r.authorization_url) throw new Error(r.error ?? "That server did not say how to sign in to it.");
          await api().tabs.create({ url: r.authorization_url });
          status.textContent = `Sign in to ${display} in the new tab…`;
          const deadline = Date.now() + 5 * 60_000;
          for (;;) {
            await sleep(2000);
            const now = (await connectorRows())?.find((x) => x.id === id);
            if (now?.credential_set_at) break;
            if (Date.now() > deadline) throw new Error("Sign-in didn't finish.");
          }
        }
        await accountRpc("set_account_mcp_server_enabled", { id, enabled: true });
        card.remove();
        deps.send(`Connected ${display}.`);
      } catch (e) {
        status.textContent = e instanceof Error ? e.message : String(e);
        connect.disabled = false;
        later.disabled = false;
      }
    })();
  });
  return card;
}
