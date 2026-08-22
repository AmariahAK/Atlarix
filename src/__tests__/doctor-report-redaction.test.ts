/**
 * The copy button's safety guarantee.
 *
 * A support blob gets pasted into chat, email and issue trackers — whatever is in
 * it is public from that moment. Probe details are built from PROVIDER error
 * messages, and providers do echo credentials back at you ("Incorrect API key
 * provided: sk-…"), so the leak path is real and not hypothetical.
 *
 * These tests seed fake secrets and assert they cannot survive. The last group is
 * the one that matters most: redaction must be shape-based, so a provider whose
 * key format nobody has seen yet does not silently become a leak.
 */
import { describe, expect, it } from "vitest";
import {
  formatDoctorReport,
  redactForSupport,
} from "@/main/doctor-report";
import type { DoctorReport } from "@/main/doctor";

const FAKE_OPENAI = "sk-proj-abc123DEF456ghi789JKL012mno345PQR";
const FAKE_ANTHROPIC = "sk-ant-api03-ZZZtopsecretvalue999888777";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("redactForSupport", () => {
  it("removes provider keys wherever they appear in a message", () => {
    const out = redactForSupport(
      `Incorrect API key provided: ${FAKE_OPENAI}. You can find your API key at ...`,
    );
    expect(out).not.toContain(FAKE_OPENAI);
    expect(out).not.toContain("sk-proj-abc123");
    expect(out).toContain("[redacted]");
  });

  it("removes an Anthropic-shaped key and a JWT", () => {
    const out = redactForSupport(`auth failed for ${FAKE_ANTHROPIC} token ${FAKE_JWT}`);
    expect(out).not.toContain(FAKE_ANTHROPIC);
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("removes labelled secrets whatever the separator or quoting", () => {
    for (const text of [
      'api_key: "hunter2hunter2hunter2"',
      "api-key=hunter2hunter2hunter2",
      "token = hunter2hunter2hunter2",
      "Authorization: Bearer hunter2hunter2hunter2",
      "password:hunter2hunter2hunter2",
    ]) {
      expect(redactForSupport(text), text).not.toContain("hunter2hunter2hunter2");
    }
  });

  /**
   * The important one. A list of known prefixes fails closed in the wrong
   * direction: the FIRST time a new provider ships a new key format, a
   * prefix-matcher leaks it. Anything long, opaque and token-shaped goes.
   */
  it("removes an unrecognized token format nobody has seen before", () => {
    const novel = "zz9plural-Z4lph4numeric0paqueStr1ngOfDoom42";
    expect(redactForSupport(`provider said: ${novel}`)).not.toContain(novel);
  });

  it("removes email addresses", () => {
    const out = redactForSupport("signed in as someone@example.com (session ok)");
    expect(out).not.toContain("someone@example.com");
  });

  it("reduces absolute paths to their filename", () => {
    const posix = redactForSupport(
      "cannot load /Users/janedoe/Library/Application Support/Atlarix/better_sqlite3.node",
    );
    expect(posix).not.toContain("janedoe");
    expect(posix).toContain("better_sqlite3.node");

    const win = redactForSupport(
      "cannot load C:\\Users\\janedoe\\AppData\\Local\\Atlarix\\app.asar",
    );
    expect(win).not.toContain("janedoe");
    expect(win).toContain("app.asar");
  });

  // Redaction that eats the message is its own failure: a report of nothing but
  // [redacted] is useless, and support would ask for an unredacted one instead.
  it("leaves ordinary diagnostic prose readable", () => {
    const text =
      "signed in, proxy reachable, balance $12.40 — 3 models, ripgrep 14.1.1 OK";
    expect(redactForSupport(text)).toBe(text);
  });

  it("keeps short version-like and hyphenated tokens", () => {
    for (const text of [
      "ripgrep 14.1.1",
      "xterm-256color",
      "electron 43.0.2",
      "provider: openai-compatible",
      "finish_reason: network_error",
    ]) {
      expect(redactForSupport(text), text).toBe(text);
    }
  });

  it("handles empty input", () => {
    expect(redactForSupport("")).toBe("");
  });
});

describe("formatDoctorReport", () => {
  const report: DoctorReport = {
    generatedAt: 1787270400000,
    appVersion: "14.36.0",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    rows: [
      {
        name: "atlarix-core",
        title: "Atlarix Core",
        what: "Signed in, and our proxy is reachable.",
        ok: true,
        severity: "ok",
        detail: "signed in, proxy reachable, balance $12.40",
        ms: 240,
      },
      {
        name: "provider-keys",
        title: "Your API keys",
        what: "Each key you have saved still authenticates.",
        ok: false,
        severity: "warn",
        detail: `1 of 2 keys failed: openai (Incorrect API key provided: ${FAKE_OPENAI})`,
        remediation: "Re-enter the failing key under Settings → AI.",
        ms: 900,
      },
      {
        name: "sqlite",
        title: "Local database",
        what: "The native sqlite module loads.",
        ok: false,
        severity: "fail",
        detail: "cannot open /Users/janedoe/Library/Atlarix/db.sqlite",
        ms: 12,
      },
    ],
  };

  it("never carries key material or a home directory into the blob", () => {
    const text = formatDoctorReport(report);
    expect(text).not.toContain(FAKE_OPENAI);
    expect(text).not.toContain("janedoe");
    expect(text).toContain("db.sqlite");
  });

  it("labels warn and fail differently, so severity survives the paste", () => {
    const text = formatDoctorReport(report);
    expect(text).toContain("WARN  Your API keys");
    expect(text).toContain("FAIL  Local database");
    expect(text).toContain("OK    Atlarix Core");
  });

  it("includes the three things support asks for first", () => {
    const text = formatDoctorReport(report);
    expect(text).toContain("14.36.0");
    expect(text).toContain("darwin/arm64");
    expect(text).toContain("packaged");
  });

  it("summarizes which checks failed", () => {
    expect(formatDoctorReport(report)).toContain(
      "2 of 3 checks failed: provider-keys, sqlite",
    );
  });

  it("says so plainly when everything passed", () => {
    const clean: DoctorReport = {
      ...report,
      rows: [{ ...report.rows[0] }],
    };
    expect(formatDoctorReport(clean)).toContain("All 1 checks passed.");
  });
});
