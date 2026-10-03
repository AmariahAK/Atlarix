import { describe, expect, it } from "vitest";
import { DatabaseNewerThanClientError } from "@/db/migrate_atlarix";
import { formatFatal } from "@/cli/errors";

describe("formatFatal", () => {
  it("is one line and a hint, never a stack, by default", () => {
    const out = formatFatal(new DatabaseNewerThanClientError(2, ["9999_x"]), false);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toMatch(/^atlarix: This Atlarix database was upgraded by a newer version/);
    expect(out).not.toMatch(/\s+at /);
  });

  it("adds the stack with --debug", () => {
    expect(formatFatal(new Error("boom"), true)).toMatch(/atlarix: boom\n\nError: boom\n\s+at /);
  });

  it("handles non-errors", () => {
    expect(formatFatal("plain", false)).toMatch(/^atlarix: plain/);
  });
});
