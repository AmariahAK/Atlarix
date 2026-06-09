import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/core";
import { sentryBeforeSendDropExpected } from "@/lib/sentry-before-send";
import { PlanLimitError } from "@/lib/plan-limit-error";

describe("sentryBeforeSendDropExpected", () => {
  it("drops free-tier workspace limit errors", () => {
    const event = {
      message: "Free plan allows 1 workspace. Upgrade to Pro for unlimited workspaces.",
    };
    expect(sentryBeforeSendDropExpected(event as ErrorEvent, undefined)).toBeNull();
  });

  it("drops PlanLimitError originals", () => {
    const event = { exception: { values: [{ type: "Error", value: "limit" }] } };
    expect(
      sentryBeforeSendDropExpected(event as ErrorEvent, {
        originalException: new PlanLimitError("Workspace limit reached"),
      }),
    ).toBeNull();
  });

  it("drops missing TextMate grammar scopes", () => {
    const event = {
      exception: {
        values: [{ type: "Error", value: "Missing grammar for scope: source.lua" }],
      },
    };
    expect(sentryBeforeSendDropExpected(event as ErrorEvent, undefined)).toBeNull();
  });

  it("drops benign Electron teardown races (Object has been destroyed)", () => {
    for (const value of [
      "Object has been destroyed",
      "Render frame was disposed before WebFrameMain could be accessed",
    ]) {
      const event = { exception: { values: [{ type: "Error", value }] } };
      expect(
        sentryBeforeSendDropExpected(event as ErrorEvent, undefined),
      ).toBeNull();
    }
  });

  it("passes through unexpected errors", () => {
    const event = {
      exception: { values: [{ type: "Error", value: "Database connection lost" }] },
    };
    expect(sentryBeforeSendDropExpected(event as ErrorEvent, undefined)).toBe(event);
  });
});
