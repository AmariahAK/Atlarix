/**
 * `cli-device` poll in ONE database call (2026-11-07). The poll used to be three
 * PostgREST requests (delete-if-approved, read, mark polled) every 5 s while a
 * sign-in waits; it is now `cli_device_poll_service`. The CLI must see exactly the
 * answers it saw before (src/cli/auth/device-sign-in.ts switches on them).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pollAnswer } from "../../supabase/functions/_shared/device-poll.ts";

describe("pollAnswer: the database's state → the RFC 8628 answer the CLI expects", () => {
  it("approved hands over the sealed session with 200", () => {
    expect(pollAnswer({ ok: true, state: "approved", sealed_session: "s.e.a.l" }, null)).toEqual({
      status: 200,
      body: { sealed_session: "s.e.a.l" },
    });
  });

  it.each([
    ["pending", "authorization_pending"],
    ["slow_down", "slow_down"],
    ["denied", "access_denied"],
    ["expired", "expired_token"],
  ])("%s → 400 %s", (state, error) => {
    expect(pollAnswer({ ok: true, state }, null)).toEqual({ status: 400, body: { error } });
  });

  it("a database failure backs the CLI off instead of ending its sign-in", () => {
    expect(pollAnswer(null, { message: "connection reset" })).toEqual({ status: 400, body: { error: "slow_down" } });
    expect(pollAnswer({ ok: false, error: "forbidden" }, null)).toEqual({ status: 400, body: { error: "slow_down" } });
    expect(pollAnswer({ ok: true, state: "approved" }, null)).toEqual({ status: 400, body: { error: "slow_down" } });
    expect(pollAnswer({ ok: true, state: "something-new" }, null)).toEqual({ status: 400, body: { error: "slow_down" } });
  });
});

describe("the poll makes one database call", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../supabase/functions/cli-device/index.ts"), "utf8");
  const poll = src.slice(src.indexOf('case "poll"'), src.indexOf('case "describe"'));

  it("calls cli_device_poll_service and touches the table no other way", () => {
    expect(poll).toMatch(/\.rpc\(\s*"cli_device_poll_service"/);
    expect(poll).not.toMatch(/\.from\(\s*"cli_device_codes"/);
  });
});

describe("migration: the one-call functions are service-only", () => {
  const DIR = path.resolve(__dirname, "../../supabase/migrations");
  const all = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => fs.readFileSync(path.join(DIR, f), "utf8"))
    .join("\n");

  function newestBody(name: string): string {
    const re = new RegExp(
      String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.${name}\s*\([\s\S]*?\$(\w*)\$([\s\S]*?)\$\1\$`,
      "gi",
    );
    let body = "";
    for (const m of all.matchAll(re)) body = m[2]!;
    if (!body) throw new Error(`no definition of public.${name}`);
    return body;
  }

  for (const [fn, sig] of [
    ["cli_device_poll_service", "text, integer"],
    ["abuse_watch_signals_service", ""],
  ] as const) {
    it(`${fn}: refuses any caller but service_role, granted to service_role only`, () => {
      expect(newestBody(fn)).toMatch(/auth\.role\(\)[\s\S]*?<>\s*'service_role'/);
      const sigRe = sig.replace(/[(),]/g, "\\$&").replace(/\s+/g, "\\s*");
      expect(all).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION public\.${fn}\(${sigRe}\) FROM PUBLIC, anon, authenticated;`));
      expect(all).toMatch(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION public\.${fn}\(${sigRe}\) TO service_role;`));
    });
  }

  it("an approved session is collected and deleted in one statement (handed out once)", () => {
    expect(newestBody("cli_device_poll_service")).toMatch(
      /DELETE FROM cli_device_codes\s+WHERE device_code_hash = p_device_code_hash AND status = 'approved'[\s\S]*?RETURNING sealed_session INTO/,
    );
  });

  it("the pending row is locked before it is read and marked polled", () => {
    expect(newestBody("cli_device_poll_service")).toMatch(/FROM cli_device_codes WHERE device_code_hash = p_device_code_hash FOR UPDATE/);
  });
});
