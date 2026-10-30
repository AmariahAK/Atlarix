/**
 * Plugin slash commands (`commands/<name>.md`): a prompt the person sends by
 * typing `/<name> <text>`, with `$ARGUMENTS` replaced by the text, as in Claude
 * Code.
 *
 * Expanded on the main side of `chat:stream`, so the app, the CLI, ACP and VS
 * Code all send the same thing; each surface only LISTS them in its own `/` menu.
 * A built-in command of the same name always wins (each surface handles its own
 * first), and `/<plugin>:<name>` reaches a plugin's command either way. The
 * message shown stays what the person typed; the model gets the expansion.
 */

import { readPluginContents } from "./manifest";
import { pluginDir } from "./paths";
import {
  appliesToFolder,
  loadPlugins,
  verifyInstalledPlugin,
} from "./registry";
import { readPluginRecords } from "./store";

export interface InstalledCommand {
  /** What follows the `/`: the bare name, or `<plugin>:<name>` when two plugins share one. */
  name: string;
  plugin: string;
  description: string;
  argumentHint?: string;
  template: string;
}

export function listPluginCommands(
  workspacePath: string | null | undefined,
): InstalledCommand[] {
  const all: InstalledCommand[] = [];
  for (const p of loadPlugins(workspacePath ?? null).plugins) {
    for (const c of p.contents.commands) {
      all.push({
        name: c.name,
        plugin: p.contents.name,
        description: c.description,
        argumentHint: c.argumentHint,
        template: c.template,
      });
    }
  }
  const taken = new Map<string, number>();
  for (const c of all) taken.set(c.name, (taken.get(c.name) ?? 0) + 1);
  return all.map((c) =>
    (taken.get(c.name) ?? 0) > 1 ? { ...c, name: `${c.plugin}:${c.name}` } : c,
  );
}

/** The prompt `/<name> <text>` stands for, or null when it is not a plugin command. */
export function expandPluginCommand(
  prompt: string,
  workspacePath: string | null | undefined,
): string | null {
  const m =
    /^\/([a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9_-]*)?)(?:\s+([\s\S]*))?$/.exec(
      prompt.trim(),
    );
  if (!m) return null;
  const wanted = m[1]!;
  const args = (m[2] ?? "").trim();
  const commands = listPluginCommands(workspacePath);
  const cmd =
    commands.find((c) => c.name === wanted) ??
    commands.find((c) => `${c.plugin}:${c.name.split(":").pop()}` === wanted);
  if (!cmd) return null;
  return cmd.template.includes("$ARGUMENTS")
    ? cmd.template.split("$ARGUMENTS").join(args)
    : args
      ? `${cmd.template}\n\n${args}`
      : cmd.template;
}

/**
 * Why `/<name>` does nothing here, when it is a command of an INSTALLED silk that
 * is not loaded: off, scoped to other folders, or changed on disk. Null when no
 * installed silk has that command. Asked only after expansion found nothing, so
 * a stale `/` menu can never send the raw text to the model as a message (A4).
 * Only command names are read from a silk that failed verification.
 */
export function unavailableCommandReason(
  prompt: string,
  workspacePath: string | null | undefined,
): string | null {
  const m = /^\/([a-z0-9][a-z0-9._-]*)(?::([a-z0-9][a-z0-9_-]*))?(?:\s|$)/.exec(
    prompt.trim(),
  );
  if (!m) return null;
  const [silkPart, cmdPart] = m[2] ? [m[1]!, m[2]] : [null, m[1]!];
  for (const record of readPluginRecords()) {
    if (silkPart && record.name !== silkPart) continue;
    let names: string[];
    try {
      names = readPluginContents(
        pluginDir(record.name),
        record.name,
      ).commands.map((c) => c.name);
    } catch {
      continue;
    }
    if (!names.includes(cmdPart)) continue;
    const typed = `/${m[2] ? `${m[1]}:${m[2]}` : m[1]}`;
    if (!record.enabled)
      return `${typed} comes from ${record.name}, which is off. Turn it on in /silks.`;
    if (!appliesToFolder(record, workspacePath)) {
      return `${typed} comes from ${record.name}, which is not on in this folder. Change that in /silks.`;
    }
    const verified = verifyInstalledPlugin(record);
    if ("problem" in verified)
      return `${typed} comes from ${record.name}: ${verified.problem}`;
  }
  return null;
}
