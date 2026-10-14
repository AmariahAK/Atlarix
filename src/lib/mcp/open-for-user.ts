/**
 * Open a sign-in page for the person using Atlarix, wherever they are using it.
 *
 * The desktop app has `shell.openExternal`. The CLI and the ACP agent run on
 * an Electron stub with no windows, where a URL handed to the renderer went
 * nowhere: an MCP server's sign-in never opened from the terminal or an
 * editor. Under `atlarix acp` the editor opens it (its extension watches
 * stderr for the line); in the terminal Atlarix opens the browser itself.
 */
import { spawn } from "node:child_process";
import { validateOpenExternalUrl } from "@/lib/external_url";

export async function openUrlForUser(url: string): Promise<void> {
  validateOpenExternalUrl(url);
  if (!/^https?:\/\//i.test(url)) throw new Error("Only web addresses can be opened.");
  if (process.env.ATLARIX_SURFACE === "cli") {
    if (process.env.ATLARIX_OPEN_URLS_VIA_STDERR === "1") {
      process.stderr.write(`Atlarix open: ${url}\n`);
      return;
    }
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    try {
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    } catch {
      // The caller shows the URL as well, for copying.
    }
    return;
  }
  const { shell } = await import("electron");
  await shell.openExternal(url);
}
