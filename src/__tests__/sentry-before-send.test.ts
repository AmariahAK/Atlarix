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

  it("redacts secrets from message, exception value, request URL, and breadcrumbs (A15)", () => {
    const event = {
      message: "auth failed with sk-ant-abcdefghijklmnopqrstuvwxyz0123",
      exception: {
        values: [{ type: "Error", value: "token ghp_" + "a".repeat(40) + " rejected" }],
      },
      request: { url: "https://api.example.com/x?key=AKIAABCDEFGHIJKLMNOP" },
      breadcrumbs: [{ message: "GET https://x/?t=AKIAABCDEFGHIJKLMNOP" }],
    };
    const out = sentryBeforeSendDropExpected(event as ErrorEvent, undefined);
    expect(out).not.toBeNull();
    expect(out!.message).not.toMatch(/sk-ant-/);
    expect(out!.exception!.values![0]!.value).not.toMatch(/ghp_/);
    expect(out!.request!.url).not.toMatch(/AKIA/);
    expect(out!.breadcrumbs![0]!.message).not.toMatch(/AKIA/);
    expect(out!.message).toMatch(/redacted secret/);
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

  it("drops intentional stream-stop aborts (ask_user_pending)", () => {
    const event = {
      exception: { values: [{ type: "AbortError", value: "ask_user_pending" }] },
    };
    const abort = new DOMException("ask_user_pending", "AbortError");
    expect(
      sentryBeforeSendDropExpected(event as ErrorEvent, {
        originalException: abort,
      }),
    ).toBeNull();
  });

  it("drops superseded_stream aborts even when originalException is not attached", () => {
    // Real-world leak: Sentry's onunhandledrejection integration reported the
    // benign single-flight abort WITHOUT the DOMException as originalException,
    // so only the serialized "AbortError: superseded_stream" text survives.
    const event = {
      exception: { values: [{ type: "AbortError", value: "superseded_stream" }] },
    };
    expect(
      sentryBeforeSendDropExpected(event as ErrorEvent, undefined),
    ).toBeNull();
  });

  it("passes through unexpected errors", () => {
    const event = {
      exception: { values: [{ type: "Error", value: "Database connection lost" }] },
    };
    expect(sentryBeforeSendDropExpected(event as ErrorEvent, undefined)).toBe(event);
  });
});
