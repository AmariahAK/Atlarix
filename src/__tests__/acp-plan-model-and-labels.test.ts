/**
 * "A different model for Plan" (plan with one model, build with another), and
 * remembered permissions as a person reads them in the editor's Auto-approve.
 */
import { describe, expect, it } from "vitest";
import { turnModelFor } from "@/cli/agent/models";
import { readablePermission } from "@/cli/acp/permission-labels";

describe("the Plan model", () => {
  const chosen = { provider: "deepseek", name: "deepseek-flash" };
  const plan = { provider: "openrouter", name: "anthropic/claude-sonnet-4.6" };
  it("plans on it, builds on the chosen one, and is off when unset", () => {
    expect(turnModelFor("plan", chosen, plan)).toEqual(plan);
    expect(turnModelFor("build", chosen, plan)).toEqual(chosen);
    expect(turnModelFor("debug", chosen, plan)).toEqual(chosen);
    expect(turnModelFor("plan", chosen, undefined)).toEqual(chosen);
    expect(turnModelFor("plan", undefined, plan)).toEqual(plan);
  });
});

describe("remembered permissions, readable", () => {
  it("commands, risky commands and file scopes", () => {
    expect(readablePermission({ kind: "command", label: "npm", decision: "always_allow", revoke: { category: "npm" } })).toEqual({
      kind: "command",
      label: "npm commands",
      decision: "always",
      risky: false,
    });
    expect(readablePermission({ kind: "command", label: "danger:rm-rf+cmd-sudo", decision: "always_deny", revoke: { category: "danger:rm-rf+cmd-sudo" } })).toEqual({
      kind: "command",
      label: "rm rf + sudo",
      decision: "never",
      risky: true,
    });
    expect(readablePermission({ kind: "file", label: "folder src", decision: "always_allow", revoke: { scopeType: "directory", scopeValue: "src" } }).label).toBe("folder src/");
    expect(readablePermission({ kind: "file", label: "extension .ts", decision: "always_allow", revoke: { scopeType: "extension", scopeValue: ".ts" } }).label).toBe(".ts files");
  });
});
