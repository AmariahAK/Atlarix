/**
 * A swallowed exit code must not disable the sandbox's grant path.
 *
 * OBSERVED 2026-08-29. An agent ran
 * `docker compose -f docker-compose-dev.yml build auth 2>&1 | tail -40`. buildx died
 * on a denied write to `~/.docker/buildx/activity/`, but a pipeline reports the LAST
 * command's status, so the whole thing exited **0**. The escalation was gated on
 * `!result.success`, so the grant card never appeared — and the agent spent six turns
 * on `xattr` and file flags diagnosing a boundary nothing had told it about.
 *
 * The counterweight is that a command reporting SUCCESS must never be silently
 * re-run: it may already have applied its side effects, and doing them twice is a
 * worse failure than the one being fixed. So the grant is persisted, the model is
 * told, and the re-run is its call.
 */
import { describe, expect, it } from "vitest";

import { sandboxEscalationDecision } from "@/lib/sandbox/wrap-command";

const DOCKER_DENIAL =
  "ERROR: failed to write /Users/dev/.docker/buildx/activity/.tmp-abc: operation not permitted";

describe("sandboxEscalationDecision", () => {
  it("escalates a command that exited 0 while printing a denial — THE BUG", () => {
    expect(
      sandboxEscalationDecision({ success: true, stdout: DOCKER_DENIAL }),
    ).toEqual({
      escalate: true,
      allowRetry: false,
    });
  });

  it("never re-runs that command — it told us it succeeded", () => {
    // The grant still lands; only the automatic re-run is withheld.
    expect(
      sandboxEscalationDecision({ success: true, stderr: DOCKER_DENIAL })
        .allowRetry,
    ).toBe(false);
  });

  it("still escalates AND retries an ordinary failure", () => {
    // The pre-existing behaviour, which is the case retrying was designed for.
    expect(
      sandboxEscalationDecision({ success: false, stderr: DOCKER_DENIAL }),
    ).toEqual({
      escalate: true,
      allowRetry: true,
    });
  });

  it("retries a failure even when no path could be attributed", () => {
    // `maybeEscalateSandboxDenial` does its own parse and returns null if there is
    // nothing to grant, so the gate must not second-guess it for failures.
    expect(
      sandboxEscalationDecision({ success: false, stderr: "boom" }),
    ).toEqual({
      escalate: true,
      allowRetry: true,
    });
  });

  it("does nothing for a clean success — no card on every passing command", () => {
    expect(
      sandboxEscalationDecision({
        success: true,
        stdout: "Successfully built abc123",
      }),
    ).toEqual({ escalate: false, allowRetry: false });
  });

  it("is not fooled by prose that merely mentions permissions", () => {
    expect(
      sandboxEscalationDecision({
        success: true,
        stdout: "checked permission denied policies for 3 roles",
      }).escalate,
    ).toBe(false);
  });

  it("reads stderr as well as stdout", () => {
    expect(
      sandboxEscalationDecision({
        success: true,
        stderr: DOCKER_DENIAL,
        stdout: "",
      }).escalate,
    ).toBe(true);
  });
});
