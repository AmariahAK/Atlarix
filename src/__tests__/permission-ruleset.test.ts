/**
 * v12 2.2 — permission ruleset compile + evaluate (deny/ask glob matching).
 */

import { describe, expect, it } from "vitest";
import {
  compileRule,
  evaluateRuleset,
  mergeRulesets,
  ruleMatchTarget,
} from "@/lib/tools/permissions/ruleset";

function compiled(deny: string[] = [], ask: string[] = []) {
  // evaluateRuleset takes the compiled shape — build it via the same helpers.
  return {
    deny: deny.map(compileRule).filter((r): r is NonNullable<typeof r> => !!r),
    ask: ask.map(compileRule).filter((r): r is NonNullable<typeof r> => !!r),
  };
}

describe("ruleMatchTarget", () => {
  it("returns the command for run_command/run_tests", () => {
    expect(ruleMatchTarget("run_command", { command: "rm -rf /" })).toBe(
      "rm -rf /",
    );
    expect(ruleMatchTarget("run_tests", { command: "npm test" })).toBe(
      "npm test",
    );
  });
  it("returns the path for file tools", () => {
    expect(ruleMatchTarget("write_file", { path: "src/.env" })).toBe(
      "src/.env",
    );
    expect(ruleMatchTarget("edit_file", { file_path: "a.ts" })).toBe("a.ts");
  });
  it("empty for name-only tools", () => {
    expect(ruleMatchTarget("read_file", {})).toBe("");
  });
});

describe("evaluateRuleset", () => {
  it("denies a command matching a deny glob", () => {
    const rs = compiled(["run_command(rm *)"]);
    expect(
      evaluateRuleset(rs, "run_command", { command: "rm -rf build" }),
    ).toEqual({
      kind: "deny",
      rule: "run_command(rm *)",
    });
  });

  it("does not deny a non-matching command", () => {
    const rs = compiled(["run_command(rm *)"]);
    expect(
      evaluateRuleset(rs, "run_command", { command: "ls -la" }),
    ).toBeNull();
  });

  it("matches file path globs", () => {
    const rs = compiled(["write_file(*.env*)"]);
    expect(
      evaluateRuleset(rs, "write_file", { path: "config/.env.local" }),
    ).toEqual({ kind: "deny", rule: "write_file(*.env*)" });
  });

  it("bare tool-name globs match regardless of target", () => {
    const rs = compiled(["browser_*"]);
    expect(evaluateRuleset(rs, "browser_navigate", {})?.kind).toBe("deny");
    expect(evaluateRuleset(rs, "read_file", {})).toBeNull();
  });

  it("deny takes precedence over ask", () => {
    const rs = compiled(["run_command(git push*)"], ["run_command(git *)"]);
    expect(
      evaluateRuleset(rs, "run_command", { command: "git push origin main" })
        ?.kind,
    ).toBe("deny");
  });

  it("ask matches when no deny rule does", () => {
    const rs = compiled([], ["run_command(git push*)"]);
    expect(
      evaluateRuleset(rs, "run_command", { command: "git push origin main" }),
    ).toEqual({ kind: "ask", rule: "run_command(git push*)" });
  });

  it("empty ruleset = no decision (pre-2.2 behavior)", () => {
    expect(
      evaluateRuleset(compiled(), "run_command", { command: "anything" }),
    ).toBeNull();
  });

  it("ignores malformed rules", () => {
    expect(compileRule("not a valid (rule (")).toBeNull();
    const rs = compiled(["", "write_file(ok*)"]);
    expect(rs.deny.length).toBe(1);
  });
});

describe("mergeRulesets (global ~/.atlarix layer, S16)", () => {
  it("unions deny and ask lists from both sides", () => {
    const merged = mergeRulesets(
      compiled(["run_command(curl *)"], ["run_command(git push*)"]),
      compiled(["write_file(*.env*)"], ["run_command(npm publish*)"]),
    );
    expect(merged.deny.map((r) => r.raw)).toEqual([
      "run_command(curl *)",
      "write_file(*.env*)",
    ]);
    expect(merged.ask.map((r) => r.raw)).toEqual([
      "run_command(git push*)",
      "run_command(npm publish*)",
    ]);
  });

  it("a global deny still wins over a workspace ask (deny > ask)", () => {
    const merged = mergeRulesets(
      compiled(["run_command(git push*)"]),
      compiled([], ["run_command(git *)"]),
    );
    expect(
      evaluateRuleset(merged, "run_command", {
        command: "git push origin main",
      })?.kind,
    ).toBe("deny");
  });

  it("returns the other side as-is when one is empty (no-allocation fast path)", () => {
    const ws = compiled(["run_command(rm *)"]);
    expect(mergeRulesets(compiled(), ws)).toBe(ws);
    expect(mergeRulesets(ws, compiled())).toBe(ws);
  });

  it("two empties stay empty (pre-2.2 behavior preserved)", () => {
    const merged = mergeRulesets(compiled(), compiled());
    expect(
      evaluateRuleset(merged, "run_command", { command: "anything" }),
    ).toBeNull();
  });
});
