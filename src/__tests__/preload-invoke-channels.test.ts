/**
 * Every IPC channel the renderer invokes must be in the preload allowlist.
 *
 * `preload.ts` gates `ipcRenderer.invoke` on `validInvokeChannels` and throws
 * `Invalid channel: <name>` for anything absent. Registering the handler in
 * `ipc_host` is NOT enough, and nothing before runtime notices the omission:
 * TypeScript is satisfied (the client passes a plain string), the handler's own
 * tests pass (they call it directly), and the failure appears only when a human
 * clicks the button.
 *
 * It happened twice in one change. `doctor:run` surfaced immediately — the panel
 * is a button that does one thing. `sessions:set-work-mode` would have failed
 * SILENTLY: its caller catches and logs a warning, so a session's work mode would
 * simply never persist, and the only trace would be a console line nobody reads.
 *
 * Two things this test learned the hard way about its own parsing, both of which
 * made it report ~20 false positives on the first run:
 *
 * 1. **Strip comments before matching quotes.** An apostrophe in a trailing `//`
 *    comment ("don't") desynchronises quote-pairing for every entry after it, so
 *    channels that were plainly present read as missing.
 * 2. **Only scan files that use the preload bridge.** Main-process files call
 *    `invoke(` too (`lib/email/resend.ts` says "main process only" in its header),
 *    and those never pass through this allowlist.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.join(__dirname, "..");

/**
 * Channels with no renderer caller today, so they cannot throw.
 *
 * `ssh:*` exists as methods on `IpcClient` that nothing in the renderer calls,
 * against handlers that ARE registered in main — a half-built feature. Listed
 * here rather than added to the allowlist, because allowlisting a channel to
 * quieten a test grants reach to something nobody can use. **Adding a caller
 * means adding the channel**, and this test will say so the moment one appears.
 */
const KNOWN_NO_RENDERER_CALLER = new Set([
  "ssh:list-hosts",
  "ssh:connect",
  "ssh:disconnect",
  "ssh:test-connection",
  // Same shape: an `IpcClient` method with no caller in the renderer.
  "get-node-path",
  "compass:get-tier-catalog",
]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

function readAllowlist(): Set<string> {
  const preload = fs.readFileSync(path.join(SRC, "preload.ts"), "utf8");
  const start = preload.indexOf("const validInvokeChannels = [");
  expect(start, "validInvokeChannels not found in preload.ts").toBeGreaterThan(
    -1,
  );
  const end = preload.indexOf("\n];", start);
  expect(end, "end of validInvokeChannels not found").toBeGreaterThan(start);
  return new Set(
    [...stripComments(preload.slice(start, end)).matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    ),
  );
}

/**
 * Files that reach IPC through the preload bridge, i.e. through `window.electron`.
 * `ipc_client.ts` qualifies via `(window as any).electron.ipcRenderer`.
 */
function bridgeUsingSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules")
          continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // preload defines the gate; its own `invoke(channel, …)` is the dynamic one.
      if (full.endsWith(path.join("src", "preload.ts"))) continue;
      const text = fs.readFileSync(full, "utf8");
      if (!/window[\s\S]{0,12}\.?\s*electron/.test(text)) continue;
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/** Channels invoked with a STRING LITERAL. A computed channel cannot be checked. */
function invokedChannels(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of bridgeUsingSources()) {
    const text = stripComments(fs.readFileSync(file, "utf8"));
    for (const m of text.matchAll(/\binvoke\(\s*["'`]([^"'`]+)["'`]/g)) {
      const rel = path.relative(SRC, file);
      const prev = found.get(m[1]) ?? [];
      if (!prev.includes(rel)) prev.push(rel);
      found.set(m[1], prev);
    }
  }
  return found;
}

describe("preload invoke-channel allowlist", () => {
  it("contains every channel the renderer actually invokes", () => {
    const allowed = readAllowlist();
    const invoked = invokedChannels();

    // If the scan finds nothing the regex has rotted, and an empty set would pass
    // for ever while covering nothing.
    expect(invoked.size).toBeGreaterThan(20);

    const missing = [...invoked.entries()]
      .filter(([channel]) => !allowed.has(channel))
      .filter(([channel]) => !KNOWN_NO_RENDERER_CALLER.has(channel))
      .map(
        ([channel, files]) => `${channel}  (invoked in ${files.join(", ")})`,
      );

    expect(
      missing,
      missing.length
        ? 'These would throw "Invalid channel: …" the first time a user clicks. ' +
            "Add them to validInvokeChannels in src/preload.ts:\n  " +
            missing.join("\n  ")
        : "",
    ).toEqual([]);
  });

  it("parses a plausible allowlist", () => {
    // Guards the PARSER, not the product: a rename or reformat that made
    // `readAllowlist` return a handful of entries would turn the check above into
    // a permanent pass. The real list is several hundred long.
    expect(readAllowlist().size).toBeGreaterThan(250);
  });

  it("keeps the known-unreachable list honest", () => {
    // If one of these ever gets allowlisted it is presumably reachable now, and
    // the exemption should go rather than sit here implying otherwise.
    const allowed = readAllowlist();
    for (const channel of KNOWN_NO_RENDERER_CALLER) {
      expect(
        allowed.has(channel),
        `${channel} is now allowlisted — drop it from KNOWN_NO_RENDERER_CALLER`,
      ).toBe(false);
    }
  });
});
