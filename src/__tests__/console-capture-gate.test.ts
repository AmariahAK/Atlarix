/**
 * THE CONTRACT CHANGED: nothing the browser reports blocks a turn any more.
 *
 * This file previously pinned the opposite — that error-level console entries
 * (and only those) were allowed to block. That gate is gone. The harness cannot
 * tell whether an error belongs to the app being built or to a page the agent
 * merely opened: a frontend on :5173 calling its own API on :8080 is one app
 * across two origins, a staging URL is the app under test, an embedded
 * third-party script is not. Every rule we could write is wrong in one direction
 * or the other, and a wrong block costs more accuracy than a missed one.
 *
 * The trigger was concrete: the agent opened YouTube to read it, Google's
 * logged-out auth probe returned 401, and the gate nagged the agent to "fix" a
 * third-party auth handshake it had no business touching.
 *
 * What remains is a failure CLASSIFIER with one consumer — `browser_test`, where
 * the agent explicitly asked "run these steps and tell me whether it passed". A
 * verdict the agent requested is not the harness overruling it.
 */

import { describe, expect, it } from "vitest";
import {
  FAILURE_CONSOLE_LEVELS,
  runtimeFailuresSince,
} from "@/lib/agent/preview-verify";
import type { BrowserSurfaceError } from "@/lib/browser/error-hook";

function entry(over: Partial<BrowserSurfaceError> = {}): BrowserSurfaceError {
  return {
    type: "console-error",
    message: "m",
    timestamp: 100,
    ...over,
  } as BrowserSurfaceError;
}

describe("no turn-blocking gate remains", () => {
  it("the blocking gate exports are gone", async () => {
    const mod = await import("@/lib/agent/preview-verify");
    // If either of these comes back, something re-introduced a gate.
    expect("getPreviewRuntimeFeedback" in mod).toBe(false);
    expect("getPreviewVisualFeedback" in mod).toBe(false);
  });

  it("the agent turn no longer consults a browser gate", async () => {
    // The clearest regression signal: run-agent-turn must not import them.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/agent/run-agent-turn.ts", "utf8");
    expect(src).not.toContain("getPreviewRuntimeFeedback");
    expect(src).not.toContain("getPreviewVisualFeedback");
  });

  it("the replacement notice cannot create a continuation, and fires once", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/agent/run-agent-turn.ts", "utf8");

    // Once per turn. The fold path's own comment records why: a per-round
    // "continue/verify" nudge re-elicited read_file on open-weight models until
    // the turn exhausted. One notice is context; every round is a loop.
    expect(src).toContain("runtimeNoticeSent");
    expect(src).toContain("if (!runtimeNoticeSent)");

    // It must sit on the PRODUCTIVE-round path (reached only on
    // finish_reason:"tool-calls" — a continuation the model already asked for),
    // never on the yield/finish path, or it is a gate again under a new name.
    const noticeAt = src.indexOf("buildRuntimeNotice(rt.streamTurnId)");
    const gateContinue = src.indexOf("Completion gate not satisfied");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeGreaterThan(gateContinue);
  });
});

describe("runtimeFailuresSince — browser_test's classifier", () => {
  it("only error counts among console levels", () => {
    expect([...FAILURE_CONSOLE_LEVELS]).toEqual(["error"]);
  });

  it("a chatty page is not a failure", () => {
    const noisy: BrowserSurfaceError[] = [];
    for (let i = 0; i < 600; i++) {
      noisy.push(
        entry({
          level: (["log", "info", "debug"] as const)[i % 3],
          message: `chatter ${i}`,
        }),
      );
    }
    noisy.push(entry({ level: "warning", message: "hydration warning" }));
    expect(runtimeFailuresSince(noisy)).toHaveLength(0);
  });

  it("a real error counts, among the noise", () => {
    const mixed = [
      entry({ level: "log" }),
      entry({ level: "error", message: "TypeError: x is not a function" }),
      entry({ level: "debug" }),
    ];
    expect(runtimeFailuresSince(mixed)).toHaveLength(1);
  });

  it("an entry with no level does not count — fail open on a verdict", () => {
    expect(runtimeFailuresSince([entry({ level: undefined })])).toHaveLength(0);
  });

  it("non-console failures count at any level", () => {
    const failures = [
      entry({ type: "load-failed", level: undefined }),
      entry({ type: "render-gone", level: undefined }),
      entry({ type: "network-failed", statusCode: 500 }),
    ];
    expect(runtimeFailuresSince(failures)).toHaveLength(3);
  });

  it("honors the baseline and the unrelated-tab label", () => {
    const entries = [
      entry({ level: "error", timestamp: 10, message: "previous run" }),
      entry({
        level: "error",
        timestamp: 200,
        unrelated: true,
        message: "other tab",
      }),
      entry({ level: "error", timestamp: 200, message: "mine" }),
    ];
    const kept = runtimeFailuresSince(entries, 100);
    expect(kept).toHaveLength(1);
    expect(kept[0].message).toBe("mine");
  });
});
