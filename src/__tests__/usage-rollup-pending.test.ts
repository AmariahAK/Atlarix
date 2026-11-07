/**
 * The account's usage counts survive a process that never reaches its send.
 *
 * Counts were kept only in memory and sent 15 minutes after the first turn or
 * at quit. A kill, a crash, a Windows sign-out or shutdown, or an installer
 * restart lost them, so the morning list called accounts that had run a turn
 * "opened, no turn yet" (2026-11-03: one turn in analytics, nothing in
 * client_usage_daily). Each turn now also writes this process's counts to
 * <userData>/usage-pending/<pid>.json; the next process adopts the files of
 * processes that are gone and sends them.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/atlarix-usage-pending-unused", getVersion: () => "15.9.9" } }));
vi.mock("@/main/settings", () => ({ readSettings: () => ({ telemetryConsent: "opted_out" }), writeSettings: () => {} }));

const rollup = await import("@/lib/analytics/usage-rollup");
const { recordTurnUsage, flushClientUsage, adoptPendingUsage, __setUsageSenderForTests, __pendingUsageRowsForTests } = rollup;

const tick = () => new Promise((r) => setTimeout(r, 0));
const today = new Date();
const ok = { end: { outcome: "ok" as const }, tokensIn: 100, tokensOut: 20, at: today, provider: "openai", model: "gpt-5" };
const cloud = async () => ({ type: "cloud" });

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

let ud: string;
let dir: string;
let sent: Array<Array<Record<string, unknown>>>;
beforeEach(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), "usage-pending-"));
  dir = path.join(ud, "usage-pending");
  process.env.ATLARIX_USER_DATA_DIR = ud;
  delete process.env.ATLARIX_HOST_TELEMETRY;
  delete process.env.ATLARIX_REPORT_SURFACE;
  sent = [];
  __setUsageSenderForTests(async (rows) => {
    sent.push(rows as never);
    return true;
  });
});
afterEach(() => {
  __setUsageSenderForTests(null);
  delete process.env.ATLARIX_USER_DATA_DIR;
  fs.rmSync(ud, { recursive: true, force: true });
});

const own = () => path.join(dir, `${process.pid}.json`);
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as Array<Record<string, unknown>>;

describe("pending usage on disk", () => {
  it("a turn's counts are on disk before any send", async () => {
    recordTurnUsage(ok, cloud);
    await tick();
    expect(read(own())).toEqual([expect.objectContaining({ model: "gpt-5", turns: 1, tokens_in: 100 })]);
  });

  it("a sent row leaves the file; a failed send keeps it", async () => {
    recordTurnUsage(ok, cloud);
    await tick();
    __setUsageSenderForTests(async () => false);
    recordTurnUsage(ok, cloud);
    await tick();
    await flushClientUsage();
    expect(read(own())).toEqual([expect.objectContaining({ turns: 2 })]);
    __setUsageSenderForTests(async (rows) => {
      sent.push(rows as never);
      return true;
    });
    recordTurnUsage(ok, cloud);
    await tick();
    await flushClientUsage();
    expect(sent.at(-1)).toEqual([expect.objectContaining({ turns: 3 })]);
    expect(fs.existsSync(own())).toBe(false);
  });

  it("a process that died before sending: the next one adopts and sends its counts", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const gone = path.join(dir, `${deadPid()}.json`);
    const row = { ...JSON.parse(JSON.stringify(__row())), turns: 3, failed_turns: 1, last_error_kind: "quota" };
    fs.writeFileSync(gone, JSON.stringify([row]));
    await adoptPendingUsage();
    expect(fs.existsSync(gone)).toBe(false);
    // Adopted counts are this process's now, on its own file too.
    expect(read(own())).toEqual([expect.objectContaining({ turns: 3 })]);
    await flushClientUsage();
    expect(sent).toEqual([[expect.objectContaining({ turns: 3, failed_turns: 1, last_error_kind: "quota" })]]);
  });

  it("never takes a live process's file", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const live = path.join(dir, `${process.ppid}.json`);
    fs.writeFileSync(live, JSON.stringify([__row()]));
    await adoptPendingUsage();
    expect(fs.existsSync(live)).toBe(true);
    expect(__pendingUsageRowsForTests()).toEqual([]);
  });

  it("drops rows older than yesterday (the server refuses them) and unreadable files", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const old = { ...__row(), day: "2026-01-01" };
    fs.writeFileSync(path.join(dir, `${deadPid()}.json`), JSON.stringify([old, __row()]));
    fs.writeFileSync(path.join(dir, `${deadPid()}.json`), "{not json");
    await adoptPendingUsage();
    expect(__pendingUsageRowsForTests()).toEqual([expect.objectContaining({ day: __row().day })]);
    expect(fs.readdirSync(dir)).toEqual([`${process.pid}.json`]);
  });

  it("two adopters never both take the same file", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const gone = path.join(dir, `${deadPid()}.json`);
    fs.writeFileSync(gone, JSON.stringify([__row()]));
    // Another process claims it first (the rename is the claim).
    fs.renameSync(gone, `${gone}.claimed-${process.ppid}`);
    await adoptPendingUsage();
    expect(__pendingUsageRowsForTests()).toEqual([]);
  });
});

function __row(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    day: now.slice(0, 10),
    surface: "app",
    editor: "",
    billing: "byok",
    provider_type: "openai",
    model: "gpt-5",
    turns: 1,
    failed_turns: 0,
    gated_turns: 0,
    tokens_in: 1,
    tokens_out: 1,
    first_seen: now,
    last_seen: now,
  };
}
