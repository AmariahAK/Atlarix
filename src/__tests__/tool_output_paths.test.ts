import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { isAllowedToolOutputPath } from "../lib/security/tool-output-paths";

describe("isAllowedToolOutputPath", () => {
  it("allows spill files under tmp atlarix-tool-outputs", () => {
    const spill = path.join(
      os.tmpdir(),
      "atlarix-tool-outputs",
      "read_file-abc123.txt",
    );
    expect(isAllowedToolOutputPath(spill)).toBe(true);
  });

  it("rejects paths outside spill dir", () => {
    expect(isAllowedToolOutputPath("/etc/passwd")).toBe(false);
  });

  it("rejects non-txt files in spill dir", () => {
    const spill = path.join(
      os.tmpdir(),
      "atlarix-tool-outputs",
      "read_file-abc123.json",
    );
    expect(isAllowedToolOutputPath(spill)).toBe(false);
  });
});
