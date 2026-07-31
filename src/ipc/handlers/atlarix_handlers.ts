/**
 * Atlarix Main Handlers
 * ====================
 * IPC handlers for folder selection and app controls
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ValidateParentDirResult {
  ok: boolean;
  /** Normalized absolute path (tilde expanded) — present when ok. */
  path?: string;
  /** True when the directory does not exist yet but will be created on use. */
  willCreate?: boolean;
  error?: string;
}

/**
 * Validate a hand-typed destination folder.
 *
 * The clone dialog lets the user TYPE a path rather than only pick one through the
 * native dialog (which can silently fail to open on some Linux desktops, leaving the
 * user with no way to proceed). Typed input needs main-process validation because the
 * renderer has no `path`/`fs`.
 *
 * A path that doesn't exist yet is accepted as long as its nearest existing ancestor is
 * a writable directory — the clone already creates missing parents.
 */
export async function validateParentDir(
  rawInput: string,
): Promise<ValidateParentDirResult> {
  const input = rawInput.trim();
  if (!input) {
    return { ok: false, error: "Choose where to save this repository." };
  }

  const expanded =
    input === "~" || input.startsWith(`~${path.sep}`) || input.startsWith("~/")
      ? path.join(os.homedir(), input.slice(1))
      : input;

  if (!path.isAbsolute(expanded)) {
    return {
      ok: false,
      error:
        process.platform === "win32"
          ? "Enter a full path (for example C:\\Users\\you\\code)."
          : "Enter a full path (for example /Users/you/code).",
    };
  }

  const resolved = path.resolve(expanded);

  // Nearest existing ancestor: what we can actually stat and check for writability.
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(existing);
  } catch {
    return { ok: false, error: `That path is not reachable: ${existing}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `Not a folder: ${existing}` };
  }
  try {
    await fs.promises.access(existing, fs.constants.W_OK);
  } catch {
    return { ok: false, error: `That folder is not writable: ${existing}` };
  }

  return { ok: true, path: resolved, willCreate: existing !== resolved };
}

/**
 * Register folder dialog handler
 */
export function registerFolderDialogHandler() {
    // Workspace/folder selection
    ipcMain.handle("dialog:openDirectory", async (event) => {
        const parent = BrowserWindow.fromWebContents(event.sender);
        const options: Electron.OpenDialogOptions = {
            properties: ["openDirectory"],
            title: "Select Workspace Folder",
            buttonLabel: "Select Workspace",
        };
        const result = parent
            ? await dialog.showOpenDialog(parent, options)
            : await dialog.showOpenDialog(options);

        return result;
    });

    // File selection (for attachments)
    ipcMain.handle("dialog:openFiles", async (_, options) => {
        const result = await dialog.showOpenDialog({
            properties: options?.properties || ["openFile", "multiSelections"],
            filters: options?.filters || [{ name: "All Files", extensions: ["*"] }],
            title: "Select Files to Attach",
            buttonLabel: "Select Files",
        });

        return result;
    });

    // Typed destination folders (clone dialog) — see validateParentDir above.
    ipcMain.handle(
        "workspace:validate-parent-dir",
        async (_event, args: { path: string }): Promise<ValidateParentDirResult> =>
            validateParentDir(args?.path ?? ""),
    );
}
