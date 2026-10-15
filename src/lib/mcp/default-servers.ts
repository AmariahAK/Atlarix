/**
 * The user's default MCP servers: the ones every workspace offers in the
 * composer's menu, ready to connect or switch. The Verified five until the user
 * (from the marketplace) or the agent (`mcp_servers` defaults) changes them.
 *
 * A setting, not a per-folder row, so a new workspace has them from the start
 * and every surface that reads the settings file (app, CLI, ACP, editor) agrees.
 */
import { readSettings, writeSettings } from "@/main/settings";
import { VERIFIED_MCP_SERVERS } from "@/shared/mcp-catalog";

export function defaultMcpServerNames(): string[] {
  return (
    readSettings().defaultMcpServers ?? VERIFIED_MCP_SERVERS.map((v) => v.name)
  );
}

export type SetDefaultsResult =
  | { ok: true; servers: string[] }
  | { ok: false; error: string };

/** Replace the defaults with these registry names, in this order. */
export async function setDefaultMcpServers(
  names: readonly string[],
): Promise<SetDefaultsResult> {
  const { getMcpCatalogEntry } = await import("./registry-catalog");
  const servers: string[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const entry = await getMcpCatalogEntry(name);
    if (!entry) unknown.push(name);
    else if (!servers.includes(entry.name)) servers.push(entry.name);
  }
  if (unknown.length) {
    return {
      ok: false,
      error: `Not in the MCP Registry: ${unknown.join(", ")}. Use the registry name search returns.`,
    };
  }
  writeSettings({ defaultMcpServers: servers });
  const { broadcastToAllWindows } = await import(
    "@/ipc/utils/broadcast_all_windows"
  );
  broadcastToAllWindows("mcp:servers-changed", { appId: null });
  return { ok: true, servers };
}

/** Add one to the defaults, or take one out. */
export async function toggleDefaultMcpServer(
  name: string,
  on: boolean,
): Promise<SetDefaultsResult> {
  const current = defaultMcpServerNames();
  const next = on
    ? [...current.filter((n) => n !== name), name]
    : current.filter((n) => n !== name);
  return setDefaultMcpServers(next);
}

export interface DefaultMcpServerStatus {
  name: string;
  title: string;
  state: "on" | "off" | "not-added" | "needs-sign-in" | "needs-key";
  where?: "local" | "account";
  id?: number | string;
  /** How a "not-added" one is added: its web address, or a local option that asks for nothing. */
  optionId?: string;
  /** Adding it asks for values (a key, a path): that happens in the marketplace. */
  needsInputs?: boolean;
}

/** The defaults and where each stands in this folder and on the account. */
export async function defaultMcpServersStatus(
  appId: number | null,
): Promise<DefaultMcpServerStatus[]> {
  const { findMcpServer } = await import("./mcp-suggestions");
  const { getMcpCatalogEntry } = await import("./registry-catalog");
  return Promise.all(
    defaultMcpServerNames().map(
      async (name): Promise<DefaultMcpServerStatus> => {
        const [here, entry] = await Promise.all([
          findMcpServer(appId, name).catch(() => null),
          getMcpCatalogEntry(name).catch(() => null),
        ]);
        const fallback = VERIFIED_MCP_SERVERS.find((v) => v.name === name)
          ?.fallback.title;
        const title = entry?.title ?? fallback ?? name;
        if (here) {
          return {
            name,
            title,
            state: here.needs
              ? `needs-${here.needs}`
              : here.enabled
                ? "on"
                : "off",
            where: here.where,
            id: here.id,
          };
        }
        const option =
          entry?.options.find((o) => o.kind === "web") ??
          entry?.options.find((o) => o.kind !== "web" && o.supported);
        return {
          name,
          title,
          state: "not-added",
          ...(option
            ? {
                optionId: option.id,
                needsInputs: option.inputs.some((i) => i.required),
              }
            : {}),
        };
      },
    ),
  );
}
