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

import { loadPlugins } from "./registry";

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
