/**
 * The agent never changes the files that decide what plugins and hooks run — the
 * plugins folder, the install record, `hooks.json` — without the person.
 *
 * - A FILE-TOOL write there is refused outright. An installed plugin's files are
 *   verified on every load, so an edit could only switch the plugin off; and the
 *   record and `hooks.json` are the person's to change. Refusing also means no
 *   "give Atlarix write access to this folder" grant is ever persisted for them.
 * - A COMMAND that names them always gets a card, with no "always allow".
 *
 * This is the v14.25 hole, prevented up front. Then, the agent could write
 * `.atlarix/hooks/hooks.json` with no card and so give itself shell on the next
 * tool call. Here the equivalent files live outside every workspace, and this
 * guard outranks every way a request can skip its card — a saved file rule, the
 * whole-folder switch (a workspace can BE the home folder), auto-approve,
 * "Allow all this turn".
 *
 * It also marks the request `systemScope`, which every unattended approver
 * (headless `atlarix run`, automations) already refuses, and offers no "always
 * allow" on the card. Shell commands are covered twice more: the sandbox never
 * grants these paths, and the command gate keys any write to `.atlarix` as
 * `protected-path`.
 */

import path from "node:path";
import {
  isPluginControlPath,
  pluginRecordsPath,
  pluginsRootDir,
  userHooksPath,
} from "./paths";

export const PLUGIN_CONTROL_EXPLANATION =
  "Changes what your plugins and hooks run";

export function touchesPluginControl(
  permRequest: { operation: string; preview: unknown },
  workspacePath: string | null | undefined,
): boolean {
  const preview = (permRequest.preview ?? {}) as Record<string, unknown>;
  if (permRequest.operation === "run_command") {
    const command = typeof preview.command === "string" ? preview.command : "";
    return commandNamesPluginControl(command);
  }
  const paths = [preview.path, preview.fromPath, preview.toPath].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  if (Array.isArray(preview.operations)) {
    for (const op of preview.operations as Array<Record<string, unknown>>) {
      for (const k of ["path", "fromPath", "toPath"]) {
        if (typeof op?.[k] === "string") paths.push(op[k] as string);
      }
    }
  }
  return paths.some((p) =>
    isPluginControlPath(
      path.isAbsolute(p) ? p : path.resolve(workspacePath || process.cwd(), p),
    ),
  );
}

/**
 * Text match, by design: a command is not a path. It names the folder outright,
 * or `.atlarix/plugins` / `plugins.json` / `.atlarix/hooks.json` in any spelling
 * (`~/.atlarix/…`, `$HOME/.atlarix/…`).
 */
function commandNamesPluginControl(command: string): boolean {
  if (!command) return false;
  const norm = command.replace(/\\/g, "/").toLowerCase();
  const literals = [pluginsRootDir(), pluginRecordsPath(), userHooksPath()].map(
    (p) => p.replace(/\\/g, "/").toLowerCase(),
  );
  if (literals.some((l) => norm.includes(l))) return true;
  return /\.atlarix\/(plugins\b|plugins\.json|hooks\.json)/.test(norm);
}

export const PLUGIN_CONTROL_REFUSAL =
  "Plugin files, plugins.json and hooks.json are changed by the person, not the agent: " +
  "ask them to edit the file, or to use /plugins.";

/**
 * The request as the card shows it; whether it may skip the card (never, when
 * true); and, for a file-tool write, the tool result that refuses it.
 */
export function guardPluginControl<
  T extends { operation: string; preview: unknown },
>(
  permRequest: T,
  workspacePath: string | null | undefined,
): { permRequest: T; pluginControl: boolean; refusal: string | null } {
  if (!touchesPluginControl(permRequest, workspacePath)) {
    return { permRequest, pluginControl: false, refusal: null };
  }
  if (permRequest.operation !== "run_command") {
    return {
      permRequest,
      pluginControl: true,
      refusal: JSON.stringify({
        success: false,
        error: PLUGIN_CONTROL_REFUSAL,
        operation: permRequest.operation,
      }),
    };
  }
  return {
    pluginControl: true,
    refusal: null,
    permRequest: {
      ...permRequest,
      preview: {
        ...(permRequest.preview as object),
        systemScope: true,
        systemScopeExplanation: PLUGIN_CONTROL_EXPLANATION,
        canAlwaysAllow: false,
      },
    },
  };
}

/**
 * True when granting `grantPath` to the sandbox would cover a control path: the
 * path itself, anything inside the plugins folder, or a folder that contains one
 * of them (`~/.atlarix`, `~`). Such a grant is never offered.
 */
export function grantCoversPluginControl(grantPath: string): boolean {
  const grant = path.resolve(grantPath);
  if (isPluginControlPath(grant)) return true;
  return [pluginsRootDir(), pluginRecordsPath(), userHooksPath()].some((p) => {
    const rel = path.relative(grant, p);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}
