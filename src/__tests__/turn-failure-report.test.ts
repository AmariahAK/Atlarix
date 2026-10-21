/**
 * A failed turn on the user's own provider reaches Sentry, tagged with where
 * it ran (billing, provider type, model, surface, editor), carrying only the
 * fixed failure word. Before this, only Core's infrastructure errors were
 * captured, so a provider that broke for every BYOK user was invisible.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@/headless/sentry-stub";
import { sentryBeforeSendDropExpected } from "@/lib/sentry-before-send";
import { coreTurnTags, reportTurnFailure, TurnFailedError } from "@/lib/analytics/turn-failure-report";

const flush = () => new Promise((r) => setTimeout(r, 0));
const custom = async () => ({ type: "custom", apiFormat: "anthropic" });
const failed = (errorKind: string, over: Record<string, unknown> = {}) => ({
  end: { outcome: "error" as const, errorKind: errorKind as never, httpStatus: 400 },
  provider: "custom::acme-corp-gateway",
  model: "claude-haiku-4-5",
  ...over,
});

beforeEach(() => {
  delete process.env.ATLARIX_REPORT_SURFACE;
  delete process.env.ATLARIX_ACP_EDITOR;
});

describe("which failed turns are reported", () => {
  it("a provider failure on the user's own provider, with the turn's tags", async () => {
    process.env.ATLARIX_REPORT_SURFACE = "acp";
    process.env.ATLARIX_ACP_EDITOR = "zed";
    const capture = vi.fn();
    reportTurnFailure(failed("bad_request"), capture, custom);
    await flush();
    expect(capture).toHaveBeenCalledTimes(1);
    const [err, ctx] = capture.mock.calls[0]!;
    expect(err).toBeInstanceOf(TurnFailedError);
    expect((err as Error).message).toBe("bad_request (custom:anthropic)");
    expect(ctx).toEqual({
      tags: {
        billing: "byok",
        provider_type: "custom:anthropic",
        model: "claude-haiku-4-5",
        surface: "acp",
        editor: "zed",
        error_kind: "bad_request",
        http_status: "400",
      },
      fingerprint: ["turn-failed", "bad_request", "custom:anthropic"],
    });
  });

  it("not what the user causes or expects, not Core, not a turn that worked", async () => {
    const capture = vi.fn();
    for (const k of ["auth", "quota", "rate_limit", "context_overflow", "content_rejected", "consent_required", "no_workspace"]) {
      reportTurnFailure(failed(k), capture, custom);
    }
    reportTurnFailure(failed("provider_5xx", { provider: "compass" }), capture);
    reportTurnFailure(failed("provider_5xx", { fellBackToCore: true }), capture);
    reportTurnFailure({ end: { outcome: "ok" }, provider: "openai" }, capture);
    reportTurnFailure({ end: { outcome: "stopped" }, provider: "openai" }, capture);
    await flush();
    expect(capture).not.toHaveBeenCalled();
  });

  it("a local model reads as local", async () => {
    const capture = vi.fn();
    reportTurnFailure(failed("no_output", { provider: "ollama" }), capture, async () => ({ type: "local" }));
    await flush();
    expect(capture.mock.calls[0]![1].tags).toMatchObject({ billing: "local", provider_type: "ollama" });
  });

  it("Core's own report carries the same tags", () => {
    expect(coreTurnTags("core-auto")).toMatchObject({ billing: "core", provider_type: "compass", model: "core-auto", surface: "app" });
  });
});

describe("through the terminal's crash reporter", () => {
  it("the envelope has the tags and none of the user's provider id, prompt or key", async () => {
    const posts: string[] = [];
    Sentry.__resetForTests();
    Sentry.init({
      dsn: "https://abc123@o1.ingest.de.sentry.io/4510981520425040",
      release: "15.9.9",
      beforeSend: sentryBeforeSendDropExpected as never,
      transport: async (_url, init) => {
        posts.push(String(init.body));
        return {};
      },
    });
    reportTurnFailure(failed("provider_5xx"), (e, ctx) => Sentry.captureException(e, ctx), custom);
    await flush();
    await Sentry.flush(500);
    expect(posts).toHaveLength(1);
    const e = JSON.parse(posts[0]!.split("\n")[2]!);
    expect(e.tags).toMatchObject({ provider_type: "custom:anthropic", error_kind: "provider_5xx", billing: "byok" });
    expect(posts[0]).not.toContain("acme-corp");
  });
});
