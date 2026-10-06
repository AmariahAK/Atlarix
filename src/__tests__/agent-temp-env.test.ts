import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  agentTempEnv,
  runShellCommandStreaming,
} from "@/ipc/utils/runShellCommand";

/**
 * The agent's scratch directory is its commands' temp directory, by the
 * platform's own variables, with nothing in any prompt. Observed 2026-10-06:
 * models reached for an unset `$SCRATCH` / `$ATLARIX_SCRATCH`, and one command
 * failed writing to `/frames`.
 */
const base = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-tempenv-")),
);
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("agentTempEnv", () => {
  it("creates the folder and points the temp variables at it", () => {
    const dir = path.join(base, "scratch-a");
    expect(agentTempEnv(dir, "darwin")).toEqual({
      ATLARIX_SCRATCH: dir,
      TMPDIR: dir,
    });
    expect(fs.existsSync(dir)).toBe(true);
    expect(agentTempEnv(dir, "win32")).toEqual({
      ATLARIX_SCRATCH: dir,
      TEMP: dir,
      TMP: dir,
    });
  });

  it("nothing for a command that is not the agent's", () => {
    expect(agentTempEnv(undefined)).toBeNull();
  });
});

describe.runIf(process.platform !== "win32")("an agent command", () => {
  // Writes through $TMPDIR rather than `mktemp`: macOS's own mktemp ignores
  // TMPDIR for its per-user folder, while tools (Python's tempfile, ffmpeg,
  // compilers) honour it.
  it("writes its temp files to its scratch, inside the sandbox too", async () => {
    const ws = path.join(base, "ws");
    fs.mkdirSync(ws);
    const scratch = path.join(base, "scratch-b");
    for (const readOnly of [false, true]) {
      const r = await runShellCommandStreaming(
        `f="$TMPDIR/probe-${readOnly}" && echo hi > "$f" && echo "$f" && echo "$ATLARIX_SCRATCH"`,
        ws,
        {
          onOutput: () => {},
          workspaceRoot: ws,
          scratchDir: scratch,
          sandbox: {
            workspacePath: ws,
            extraWritablePaths: [scratch],
            readOnly,
          },
        },
      );
      const [made, named] = r.stdout.trim().split("\n");
      expect(r.exitCode, `readOnly=${readOnly}: ${r.stderr}`).toBe(0);
      expect(fs.realpathSync(path.dirname(made!))).toBe(
        fs.realpathSync(scratch),
      );
      expect(fs.readFileSync(made!, "utf8").trim()).toBe("hi");
      expect(named).toBe(scratch);
    }
  });
});
