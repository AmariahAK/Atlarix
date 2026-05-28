import { describe, expect, it } from "vitest";
import { sentryBeforeSendDropExpected } from "@/lib/sentry-before-send";
import { PlanLimitError } from "@/lib/plan-limit-error";

describe("sentryBeforeSendDropExpected", () => {
  it("drops free-tier workspace limit errors", () => {
    const event = {
      message: "Free plan allows 1 workspace. Upgrade to Pro for unlimited workspaces.",
    };
    expect(sentryBeforeSendDropExpected(event, undefined)).toBeNull();
  });

  it("drops PlanLimitError originals", () => {
    const event = { exception: { values: [{ type: "Error", value: "limit" }] } };
    expect(
      sentryBeforeSendDropExpected(event, {
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
    expect(sentryBeforeSendDropExpected(event, undefined)).toBeNull();
  });

  it("passes through unexpected errors", () => {
    const event = {
      exception: { values: [{ type: "Error", value: "Database connection lost" }] },
    };
    expect(sentryBeforeSendDropExpected(event, undefined)).toBe(event);
  });
});
