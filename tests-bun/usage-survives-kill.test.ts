/**
 * A CLI killed after a turn and before its usage send: the next process sends
 * that turn (client_usage_daily used to miss it; the morning list then said
 * "opened, no turn yet"). A real SIGKILL, so no exit or quit code runs.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("a turn counted by a killed process is sent by the next one", async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "usage-kill-"));
  const child = spawnSync(
    process.execPath,
    ["run", "--preload", "./tests-bun/preload.ts", "tests-bun/fixtures/usage-then-kill.ts", ud],
    { cwd: path.join(import.meta.dir, ".."), encoding: "utf8", timeout: 60_000 },
  );
  expect(child.stdout).toContain("COUNTED");
  expect(child.signal).toBe("SIGKILL");

  process.env.ATLARIX_USER_DATA_DIR = ud;
  const r = await import("../src/lib/analytics/usage-rollup");
  const sent: unknown[][] = [];
  r.__setUsageSenderForTests(async (rows) => {
    sent.push(rows);
    return true;
  });
  await r.adoptPendingUsage();
  await r.flushClientUsage();
  expect(sent).toEqual([[expect.objectContaining({ surface: "cli", model: "gpt-5", turns: 1, tokens_in: 42, tokens_out: 7 })]]);
  r.__setUsageSenderForTests(null);
  fs.rmSync(ud, { recursive: true, force: true });
}, 90_000);
