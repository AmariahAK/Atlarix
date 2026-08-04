import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The preload `on` wrapper strips the Electron event and forwards ONLY the
 * payload (`preload.ts`: `(_event, ...args) => listener(...args)`), so every
 * renderer listener must be `(payload) => …`.
 *
 * Eleven listeners had been written Electron-style as `(_e, payload)`. `_e`
 * silently received the payload, `payload` was `undefined`, and each one's
 * `"chatId" in payload` guard failed — so eleven features were dead in the
 * shipped app with no error anywhere: stream phase/status, stream pulse,
 * tool-input progress, write preview, reset-partial, models.dev status,
 * fullscreen changes, plan file-updated, autonomous session-complete, terminal
 * instances updated, and workspace-opened-from-CLI.
 *
 * `PreloadIpcRenderer.on` is now typed to one parameter, which makes this a
 * compile error inside ipc_client.ts. This test covers the gap that typing
 * cannot: call sites that reach the renderer through an `as any` cast.
 */

const REPO_ROOT = path.resolve(__dirname, "../..");

const FILES = [
  "src/ipc/ipc_client.ts",
  "src/hooks/useAIPanelListener.ts",
  "src/lib/renderer-ipc-bridge.ts",
  "src/lib/auth/auth-ipc-bridge.ts",
];

/** `.on("channel", (_event, payload) => …)` — the broken Electron-style shape. */
const TWO_ARG_LISTENER = /\.on\(\s*["'][^"']+["']\s*,\s*\(\s*_?e(?:vent)?\s*(?::[^,)]+)?\s*,/;

describe("renderer IPC listeners take exactly one argument", () => {
  it.each(FILES)("%s has no Electron-style (event, payload) listener", (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => TWO_ARG_LISTENER.test(line));
    expect(offenders).toEqual([]);
  });

  it("also rejects the named-listener form assigned before .on(...)", () => {
    // `const listener = (_event: unknown, payload: X) => handler(payload)` —
    // two of the eleven hid in this shape and grep for `.on("…", (_e` missed them.
    const src = fs.readFileSync(path.join(REPO_ROOT, "src/ipc/ipc_client.ts"), "utf8");
    expect(src).not.toMatch(/const listener = \(_event: unknown,/);
  });

  it("the regex actually catches the shape it is guarding against", () => {
    expect(
      TWO_ARG_LISTENER.test(`this.ipcRenderer.on("chat:x", (_e, payload: unknown) => {`),
    ).toBe(true);
    expect(
      TWO_ARG_LISTENER.test(`this.ipcRenderer.on("chat:x", (payload: unknown) => {`),
    ).toBe(false);
  });
});
