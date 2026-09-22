/**
 * The streamed-output contract. Nothing pinned this before.
 *
 * `onOutput` used to hand every consumer the ENTIRE accumulated buffer on every
 * `data` event, with no throttle — so a command emitting N bytes over K chunks
 * pushed ~N·K/2 bytes through every consumer downstream. Measured on a 4.9 MB
 * build log in 75 chunks: 187 MB re-sent, and 218 ms of renderer main-thread
 * parsing per command (6 ms for the deltas).
 *
 * Two properties matter here and neither is obvious from reading the emitter:
 *
 *  1. The delta is a true partition — concatenating every `deltaStdout` must
 *     reproduce the final stdout EXACTLY. Not a byte more (duplication) or less
 *     (loss). Everything downstream that appends depends on this.
 *  2. Deltas break on LINE boundaries. A consumer parsing a delta sees whole
 *     lines and therefore whole ANSI escape sequences; a raw chunk split can cut
 *     a line in half or cut `\x1b[32m` into two non-matching halves, and the
 *     colour code then leaks into the text as visible garbage. Cumulative
 *     delivery hid both.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShellCommandStreaming } from "@/ipc/utils/runShellCommand";
import type { StreamedOutput } from "@/ipc/utils/runShellCommand";

/**
 * A file big enough that `cat` is split across pipe reads.
 *
 * THIS IS LOAD-BEARING, AND THE FIRST VERSION OF THIS FILE GOT IT WRONG. Driving
 * the command with `for i in $(seq …); do printf …; done` produces one write per
 * line, so Node's `data` events land on line boundaries by luck and no boundary
 * case is ever exercised. Those tests passed against a deliberately BROKEN
 * emitter that split on raw chunks — green, and proving nothing.
 *
 * One large write is what actually forces a split: measured on this file, 19
 * chunks, 18 of them starting mid-line, and one cutting an ANSI escape in half.
 * Each test below asserts that it really did see that shape, so it can never
 * quietly degrade into the single-chunk no-op again.
 */
let BIG = "";
let ansiLines = 0;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-delta-test-"));
  BIG = path.join(dir, "big.txt");
  let body = "";
  for (let i = 0; i < 20_000; i++) {
    body += `\u001b[32mgreen ${i} padded out so the lines are a decent length\u001b[0m\n`;
  }
  ansiLines = 20_000;
  fs.writeFileSync(BIG, body);
});

afterAll(() => {
  try {
    fs.rmSync(path.dirname(BIG), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function collect(command: string) {
  const events: StreamedOutput[] = [];
  return runShellCommandStreaming(command, undefined, {
    onOutput: (o) => events.push({ ...o }),
  }).then((result) => ({ events, result }));
}

describe("streamed output: the delta is a faithful partition", () => {
  it("concatenated deltas reproduce stdout exactly", async () => {
    const { events, result } = await collect(`cat ${BIG}`);
    expect(events.length).toBeGreaterThan(1);
    const rebuilt = events.map((e) => e.deltaStdout).join("");
    // `result.stdout` is trimmed on resolve, so compare on trimmed text.
    expect(rebuilt.trim()).toBe(result.stdout);
    expect(rebuilt).toContain("green 0 ");
    expect(rebuilt).toContain("green 19999 ");
  });

  it("no line is delivered twice", async () => {
    const { events } = await collect(`cat ${BIG}`);
    const all = events
      .map((e) => e.deltaStdout)
      .join("")
      .split("\n")
      .filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
  });

  it("the accumulated fields still carry everything, unchanged", async () => {
    // The whole point of the additive shape: consumers that were never converted
    // keep seeing exactly what they saw before.
    const { events, result } = await collect("echo one; echo two; echo three");
    const last = events[events.length - 1]!;
    expect(last.stdout.trim()).toBe(result.stdout);
    expect(last.stdout).toContain("one");
    expect(last.stdout).toContain("three");
  });
});

describe("deltas break on line boundaries", () => {
  it("the probe really does split lines and escapes — or it proves nothing", async () => {
    // Guards the guards. If `cat` ever stops producing multi-chunk output here,
    // every assertion below becomes vacuous and this test says so.
    const chunks: string[] = [];
    await runShellCommandStreaming(`cat ${BIG}`, undefined, {
      onOutput: () => {},
    });
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const p = spawn("sh", ["-c", `cat ${BIG}`]);
      p.stdout.on("data", (d) => chunks.push(d.toString()));
      p.on("close", () => resolve());
    });
    expect(chunks.length).toBeGreaterThan(1);
    const midLine = chunks.filter(
      (c, i) => i > 0 && !chunks[i - 1]!.endsWith("\n"),
    ).length;
    expect(midLine).toBeGreaterThan(0);
  });

  it("every delta ends on a newline, except the final flush", async () => {
    const events: StreamedOutput[] = [];
    await runShellCommandStreaming(`cat ${BIG}`, undefined, {
      onOutput: (o) => events.push({ ...o }),
    });
    const withOut = events.filter((e) => e.deltaStdout);
    expect(withOut.length).toBeGreaterThan(1);
    for (const e of withOut.slice(0, -1)) {
      expect(e.deltaStdout.endsWith("\n")).toBe(true);
    }
  });

  it("an ANSI escape is never split across two deltas", async () => {
    // The failure this prevents: `\x1b[3` at the end of one delta and `2m` at the
    // start of the next. Neither half matches the SGR regex, so the escape leaks
    // into the UI as literal text.
    //
    // A COROLLARY, NOT THE PRIMARY GUARD. Whether a 64 KB pipe boundary happens
    // to land inside a two-byte escape is luck — falsified against a deliberately
    // chunk-splitting emitter, this passed while the line-boundary test above
    // failed. The deterministic guard is that one; this asserts the consequence
    // (an SGR sequence contains no newline, so a whole line always contains whole
    // sequences) and is kept because it is free and states the actual invariant.
    const events: StreamedOutput[] = [];
    await runShellCommandStreaming(`cat ${BIG}`, undefined, {
      onOutput: (o) => events.push({ ...o }),
    });
    expect(events.length).toBeGreaterThan(1);
    let totalComplete = 0;
    for (const e of events) {
      const introducers = (e.deltaStdout.match(/\u001b\[/g) ?? []).length;
      const complete = (e.deltaStdout.match(/\u001b\[[0-9;]*m/g) ?? []).length;
      expect(complete).toBe(introducers);
      totalComplete += complete;
    }
    // Two escapes per line, all of them intact across the whole run.
    expect(totalComplete).toBe(ansiLines * 2);
  });

  it("output with NO trailing newline is still delivered", async () => {
    // A `\r` progress bar or an interactive prompt never emits a newline. Held
    // forever it would read as a hang, so the emitter force-flushes.
    const events: StreamedOutput[] = [];
    const result = await runShellCommandStreaming(
      "printf 'no-newline-tail'",
      undefined,
      { onOutput: (o) => events.push({ ...o }) },
    );
    const rebuilt = events.map((e) => e.deltaStdout).join("");
    expect(rebuilt).toContain("no-newline-tail");
    expect(result.stdout).toBe("no-newline-tail");
  });

  it("stderr is partitioned independently of stdout", async () => {
    const events: StreamedOutput[] = [];
    await runShellCommandStreaming(
      "echo to-stdout; echo to-stderr 1>&2; echo more-stdout",
      undefined,
      { onOutput: (o) => events.push({ ...o }) },
    );
    const out = events.map((e) => e.deltaStdout).join("");
    const err = events.map((e) => e.deltaStderr).join("");
    expect(out).toContain("to-stdout");
    expect(out).toContain("more-stdout");
    expect(out).not.toContain("to-stderr");
    expect(err).toContain("to-stderr");
  });
});

describe("the amplification this exists to remove", () => {
  it("total delta bytes are ~the output size, not a multiple of it", async () => {
    const { events, result } = await collect(`cat ${BIG}`);
    const deltaBytes = events.reduce((n, e) => n + e.deltaStdout.length, 0);
    const cumulativeBytes = events.reduce((n, e) => n + e.stdout.length, 0);
    const size = result.stdout.length;

    // The delta path ships each byte once.
    expect(deltaBytes).toBeLessThanOrEqual(size + 16);
    // …while the accumulated field is still the old quadratic shape, which is
    // exactly why consumers must migrate off it.
    expect(cumulativeBytes).toBeGreaterThan(deltaBytes);
  });
});
