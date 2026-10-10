/**
 * CLI/app → editor handoff: open a session in VS Code (or Cursor, Kiro…) in
 * Atlarix's extension. The editor's own link scheme reaches the extension's
 * URI handler (packages/vscode/src/extension.ts), which opens the folder if it
 * isn't already and loads the session; the CLI, the app and the editor share
 * one database, so the session is simply there.
 */
import { spawn } from "node:child_process";

/** The editors built on VS Code that Atlarix's extension runs in, by their link scheme. */
export const EDITORS: Record<string, { scheme: string; name: string }> = {
  vscode: { scheme: "vscode", name: "VS Code" },
  code: { scheme: "vscode", name: "VS Code" },
  insiders: { scheme: "vscode-insiders", name: "VS Code Insiders" },
  cursor: { scheme: "cursor", name: "Cursor" },
  kiro: { scheme: "kiro", name: "Kiro" },
  windsurf: { scheme: "windsurf", name: "Windsurf" },
  vscodium: { scheme: "vscodium", name: "VSCodium" },
  antigravity: { scheme: "antigravity", name: "Antigravity" },
};

/** The extension's id: publisher.name. */
const EXTENSION = "atlarix.atlarix";

export function editorLink(scheme: string, sessionId: string, folder: string): string {
  const q = new URLSearchParams({ session: sessionId, folder });
  return `${scheme}://${EXTENSION}/open?${q.toString()}`;
}

/**
 * Which editor to use when none is named: the one whose terminal this is (each
 * sets VSCODE_GIT_ASKPASS_NODE to a path inside its own app), else VS Code.
 */
export function guessEditor(env: NodeJS.ProcessEnv = process.env): string {
  const hint = `${env.VSCODE_GIT_ASKPASS_NODE ?? ""} ${env.__CFBundleIdentifier ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
  for (const key of ["cursor", "kiro", "windsurf", "antigravity", "vscodium", "insiders"]) {
    if (hint.includes(key)) return key;
  }
  return "vscode";
}

/** What each platform runs to open a link. */
export function openCommand(platform: NodeJS.Platform, url: string): { file: string; args: string[] } {
  if (platform === "darwin") return { file: "open", args: [url] };
  if (platform === "win32") return { file: "cmd.exe", args: ["/c", "start", "", url.replace(/&/g, "^&")] };
  return { file: "xdg-open", args: [url] };
}

export async function openInEditor(
  sessionId: string,
  folder: string,
  editor?: string,
): Promise<{ ok: boolean; editor: string; error?: string }> {
  const key = (editor || guessEditor()).toLowerCase();
  const target = EDITORS[key];
  if (!target) {
    return { ok: false, editor: key, error: `Unknown editor "${editor}". Try: ${Object.keys(EDITORS).filter((k) => k !== "code").join(", ")}.` };
  }
  if (!/^[\w-]+$/.test(sessionId)) return { ok: false, editor: target.name, error: "This session has no id yet." };
  const { file, args } = openCommand(process.platform, editorLink(target.scheme, sessionId, folder));
  return new Promise((resolve) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (e) => resolve({ ok: false, editor: target.name, error: `Couldn't open ${target.name}: ${e.message}` }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true, editor: target.name });
    });
  });
}
