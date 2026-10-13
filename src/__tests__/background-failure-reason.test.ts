import { describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({ default: { scope: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }));
import { failureReason } from "@/lib/agent/background-commands";

describe("a failed background command says why (QA)", () => {
  it("the last line of an ordinary failure", () => {
    expect(failureReason("=== STDOUT ===\n$ tsgo -b\n=== STDERR ===\ntsgo: command not found\n")).toBe("tsgo: command not found");
  });
  it("PowerShell's wrapped message, not its trailer", () => {
    const out = "npx : The term 'npx' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the\nspelling of the name, or if a path was included, verify that the path is correct and try again.\nAt line:1 char:1\n+ npx --version\n+ ~~~\n    + CategoryInfo          : ObjectNotFound: (npx:String) [], CommandNotFoundException\n";
    expect(failureReason(out)).toMatch(/^npx : The term 'npx' is not recognized .* Check the spelling of the name/);
    expect(failureReason(out).length).toBeLessThanOrEqual(160);
  });
});
