/**
 * Copy on select, like Claude Code: release the mouse over a selection and the
 * text is on the clipboard.
 *
 * Two routes, because neither reaches everywhere:
 *   OSC 52    the terminal sets the clipboard itself. Works over SSH and in
 *             iTerm2, Ghostty, kitty, WezTerm, Windows Terminal, tmux (with
 *             set-clipboard on). macOS Terminal.app ignores it.
 *   native    pbcopy (macOS), clip (Windows, and WSL via clip.exe),
 *             wl-copy / xclip / xsel (Linux). Only on THIS machine, so skipped
 *             over SSH, where it would fill the remote's clipboard.
 *
 * `clip` reads its input in the console's code page unless it starts with a
 * UTF-16LE byte-order mark, so it is given exactly that: without it, anything
 * past ASCII (é, emoji, the transcript's ● and └) arrives mangled.
 */
import { spawn } from "node:child_process";

export interface Osc52 {
  copyToClipboardOSC52(text: string): boolean;
}

/** A copy command, and how to encode what it is given. */
export type CopyRoute = [cmd: string, args: string[], encoding?: "utf16le-bom"];

/** This machine's copy commands, best first; none over SSH. */
export function nativeCopyCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CopyRoute[] {
  if (env.SSH_CONNECTION || env.SSH_TTY) return [];
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip", [], "utf16le-bom"]];
  return [
    ...(env.WAYLAND_DISPLAY ? ([["wl-copy", []]] as CopyRoute[]) : []),
    ...(env.DISPLAY
      ? ([
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
        ] as CopyRoute[])
      : []),
    // WSL: Windows' own clipboard, which is the one the user's terminal pastes from.
    ...(env.WSL_DISTRO_NAME || env.WSL_INTEROP ? ([["clip.exe", [], "utf16le-bom"]] as CopyRoute[]) : []),
  ];
}

/** What the copy tool is fed. */
export function encodeFor(text: string, encoding?: CopyRoute[2]): Buffer {
  if (encoding !== "utf16le-bom") return Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf16le")]);
}

function runCopy(cmd: string, args: string[], input: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.on("error", () => resolve(false));
      child.stdin.end(input);
    } catch {
      resolve(false);
    }
  });
}

/** Copy `text`; resolves true when at least one route took it. */
export async function copyText(text: string, terminal: Osc52 | null): Promise<boolean> {
  let ok = false;
  try {
    ok = terminal?.copyToClipboardOSC52(text) ?? false;
  } catch {
    /* fall through to native */
  }
  for (const [cmd, args, encoding] of nativeCopyCommand()) {
    if (await runCopy(cmd, args, encodeFor(text, encoding))) return true;
  }
  return ok;
}
