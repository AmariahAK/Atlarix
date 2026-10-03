#!/usr/bin/env bun
/**
 * PROBE (throwaway, not shipped): does a hidden system Chromium pass Brave
 * Search's bot check? Decides the CLI's free web-search tier (plan Phase 0).
 *
 * Launches an installed Chromium browser with `--headless=new` and a throwaway
 * profile, drives it over the DevTools protocol, and runs the app's own result
 * extractor (`kernelCall({op:"search-results"})`) on each results page, so the
 * count is exactly what the app's search tier would get.
 *
 * Usage: bun scripts/probe-headless-search.ts [--offscreen] [browserPath]
 *
 * `--offscreen` runs the browser as a normal (non-headless) window placed off
 * screen instead of `--headless=new`. Neither mode alters the browser's
 * identity (no user-agent or automation-flag changes): the probe measures what
 * an honest browser gets, not how to get past a bot check.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kernelCall } from "../src/lib/browser/page-scripts/index";

const offscreen = process.argv.includes("--offscreen");
const CANDIDATES = [
  process.argv.slice(2).find((a) => !a.startsWith("--")),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean) as string[];
const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) throw new Error("no Chromium browser found");

const QUERIES = [
  "vite react typescript setup",
  "drizzle orm sqlite migrations",
  "express rate limit middleware",
  "bun build compile single executable",
  "postgres jsonb index performance",
  "tailwind responsive grid",
  "rust tokio spawn blocking",
  "next.js app router server actions",
  "python asyncio gather timeout",
  "git rebase interactive squash",
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-probe-"));
const port = 9300 + Math.floor(Math.random() * 400);
const browserArgs = [
  ...(offscreen ? ["--window-position=-32000,-32000", "--window-size=1280,900"] : ["--headless=new"]),
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
];
// macOS: a visible (off-screen) window must still never take focus from the
// terminal the user is typing in. `open -g` does not bring it forward; `-j`
// launches it hidden; `-n` makes a new instance even if the browser is open.
const appBundle = browser.includes(".app/") ? browser.slice(0, browser.indexOf(".app/") + 4) : null;
const proc =
  offscreen && process.platform === "darwin" && appBundle
    ? spawn("open", ["-g", "-j", "-n", "-a", appBundle, "--args", ...browserArgs], { stdio: "ignore" })
    : spawn(browser, browserArgs, { stdio: "ignore" });

async function cdpTarget(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error("DevTools endpoint never came up");
}

const ws = new WebSocket(await cdpTarget());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
const loads: (() => void)[] = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Page.loadEventFired") {
    loads.splice(0).forEach((f) => f());
  }
});
const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
const ua = (await send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true }))
  .result?.result?.value;
console.log(`browser: ${path.basename(browser)} (${offscreen ? "off-screen window" : "headless"})\nuser agent: ${ua}\n`);

type Outcome = "results" | "captcha" | "challenge" | "empty";
let total = 0;
const tally: Record<Outcome, number> = { results: 0, captcha: 0, challenge: 0, empty: 0 };
for (const q of QUERIES) {
  await send("Page.navigate", { url: `https://search.brave.com/search?q=${encodeURIComponent(q)}` });
  // Poll for the answer rather than reading after a fixed delay: results render
  // client-side, and a fixed wait cannot tell "not yet" from "never".
  let results: unknown[] = [];
  let title = "";
  let outcome: Outcome = "empty";
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    title = String(
      (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result?.result?.value ?? "",
    );
    if (/captcha/i.test(title)) {
      outcome = "captcha";
      break;
    }
    // Brave's softer check keeps the plain "Brave Search" title; only the body says it.
    const body = String(
      (await send("Runtime.evaluate", { expression: "document.body?.innerText ?? ''", returnByValue: true })).result
        ?.result?.value ?? "",
    );
    if (/not a bot|verify you are human|verifying/i.test(body)) {
      outcome = "challenge";
      break;
    }
    const out = await send("Runtime.evaluate", {
      expression: kernelCall({ op: "search-results", max: 10 } as never),
      returnByValue: true,
      awaitPromise: true,
    });
    results = (out.result?.result?.value?.results ?? []) as unknown[];
    if (results.length > 0) {
      outcome = "results";
      break;
    }
  }
  tally[outcome]++;
  total += results.length;
  console.log(`${outcome.padEnd(7)} ${String(results.length).padStart(2)}  "${q}"  (title: ${title.slice(0, 50)})`);
  await Bun.sleep(1500);
}
console.log(
  `\n${tally.results}/${QUERIES.length} with results, ${tally.captcha} captcha, ${tally.challenge} bot-check, ${tally.empty} empty; ${total} results total`,
);

await send("Browser.close").catch(() => {});
ws.close();
proc.kill();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(0);
