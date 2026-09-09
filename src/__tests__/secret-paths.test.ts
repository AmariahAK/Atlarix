import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertReadablePath,
  PATH_ESCAPE_BLOCK_MESSAGE,
} from "../lib/security/env-secret-paths";

const WS = path.join(os.tmpdir(), "atlarix-secret-test-ws");

// Like opencode / Claude Code, in-workspace files (incl. .env / keys) read
// freely — the ONLY read-side gate is the workspace boundary.
describe("assertReadablePath (workspace confinement)", () => {
  it("allows in-workspace files, including a project's own .env", () => {
    expect(() => assertReadablePath("src/index.ts", WS)).not.toThrow();
    expect(() => assertReadablePath(".env", WS)).not.toThrow();
    expect(() => assertReadablePath("config/.env.local", WS)).not.toThrow();
    expect(() => assertReadablePath("deploy/id_rsa", WS)).not.toThrow();
  });

  it("blocks traversal / paths that escape the workspace root", () => {
    for (const p of [
      "../../.env",
      "./foo/../../.env.local",
      "../README.md",
      "/etc/passwd",
    ]) {
      expect(() => assertReadablePath(p, WS)).toThrow(
        PATH_ESCAPE_BLOCK_MESSAGE,
      );
    }
  });
});
