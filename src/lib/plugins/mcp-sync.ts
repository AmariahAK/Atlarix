/**
 * A plugin's MCP servers, as this folder's ordinary `mcp_servers` rows.
 *
 * Each row is tagged `registryId = "plugin:<plugin>:<server>"` and named
 * `<plugin>-<server>`. Synced whenever a folder's servers are listed: rows
 * appear for every verified plugin that is on for the folder, and go when the
 * plugin is removed, switched off, scoped away or fails verification.
 *
 * A new row lands SWITCHED OFF, exactly like an imported config: nothing spawns
 * because a plugin was installed. The person turns it on in /mcp or Settings,
 * where the per-folder limit applies, and every tool call still goes through the
 * normal MCP consent card. The command, args and env names were shown in full at
 * the plugin's second confirm.
 *
 * `${CLAUDE_PLUGIN_ROOT}` / `${ATLARIX_PLUGIN_ROOT}` in the command, args and env
 * become the plugin's folder, as in Claude Code.
 */

import { and, eq, like } from "drizzle-orm";
import log from "electron-log";
import { db } from "@/db";
import { apps, mcpServers } from "@/db/schema";
import { resolveAppPath } from "@/paths/paths";
import { encryptEnvForDb } from "@/lib/security/db-secrets";
import type { PluginMcpServer } from "./manifest";
import { loadPlugins } from "./registry";

const logger = log.scope("plugins");

const TAG_PREFIX = "plugin:";

export function pluginMcpTag(plugin: string, server: string): string {
  return `${TAG_PREFIX}${plugin}:${server}`;
}

interface DesiredRow {
  tag: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  url: string | null;
}

function withRoot(text: string, root: string): string {
  return text.replace(/\$\{(CLAUDE|ATLARIX)_PLUGIN_ROOT\}/g, root);
}

export function desiredPluginMcpRows(workspacePath: string): DesiredRow[] {
  const out: DesiredRow[] = [];
  for (const p of loadPlugins(workspacePath).plugins) {
    for (const s of p.contents.mcpServers)
      out.push(toRow(p.contents.name, p.dir, s));
  }
  return out;
}

function toRow(plugin: string, root: string, s: PluginMcpServer): DesiredRow {
  const env = s.env
    ? Object.fromEntries(
        Object.entries(s.env).map(([k, v]) => [k, withRoot(v, root)]),
      )
    : null;
  return {
    tag: pluginMcpTag(plugin, s.name),
    name: `${plugin}-${s.name}`,
    transport: s.transport,
    command: s.command ? withRoot(s.command, root) : null,
    args: s.args ? s.args.map((a) => withRoot(a, root)) : null,
    env: env && Object.keys(env).length > 0 ? env : null,
    url: s.url ?? null,
  };
}

/** Make this folder's plugin rows match its verified plugins. */
export async function syncPluginMcpServers(
  appId: number,
  workspacePath: string,
): Promise<void> {
  const desired = new Map(
    desiredPluginMcpRows(workspacePath).map((d) => [d.tag, d]),
  );
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, appId)));

  const names = new Set(rows.map((r) => r.name.toLowerCase()));
  for (const row of rows) {
    if (!row.registryId?.startsWith(TAG_PREFIX)) continue;
    const want = desired.get(row.registryId);
    if (!want) {
      await db.delete(mcpServers).where(eq(mcpServers.id, row.id));
      logger.info(`plugin MCP server removed from folder: ${row.name}`);
      continue;
    }
    desired.delete(row.registryId);
    const changed =
      row.transport !== want.transport ||
      row.command !== want.command ||
      JSON.stringify(row.args ?? null) !== JSON.stringify(want.args) ||
      row.url !== want.url;
    if (changed) {
      // An update the person approved at its second confirm: new config, and
      // switched off again so the changed command does not start unprompted.
      await db
        .update(mcpServers)
        .set({
          transport: want.transport,
          command: want.command,
          args: want.args,
          envJson: encryptEnvForDb(want.env),
          url: want.url,
          enabled: false,
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, row.id));
    }
  }

  for (const want of desired.values()) {
    if (names.has(want.name.toLowerCase())) {
      logger.warn(
        `plugin MCP server ${want.tag} not added: this folder already has a server named ${want.name}`,
      );
      continue;
    }
    await db.insert(mcpServers).values({
      name: want.name,
      transport: want.transport,
      command: want.command,
      args: want.args,
      envJson: encryptEnvForDb(want.env),
      url: want.url,
      enabled: false,
      scope: "workspace",
      appId,
      authType: want.env ? "env" : "none",
      fromRegistry: false,
      registryId: want.tag,
    });
    names.add(want.name.toLowerCase());
  }
}

/** Every folder's rows from one plugin, for /plugins remove and off. */
export async function removePluginMcpRows(plugin: string): Promise<void> {
  await db
    .delete(mcpServers)
    .where(like(mcpServers.registryId, `${TAG_PREFIX}${plugin}:%`));
}

/**
 * The same, from a folder's id, for the places that list servers by id. Never
 * throws: a failed sync leaves the folder's rows as they were and is logged.
 */
export async function syncPluginMcpServersForApp(appId: number): Promise<void> {
  try {
    const [app] = await db
      .select({ path: apps.path })
      .from(apps)
      .where(eq(apps.id, appId));
    if (!app?.path) return;
    await syncPluginMcpServers(appId, resolveAppPath(app.path));
  } catch (err) {
    logger.warn(`plugin MCP sync failed for folder ${appId}: ${String(err)}`);
  }
}
