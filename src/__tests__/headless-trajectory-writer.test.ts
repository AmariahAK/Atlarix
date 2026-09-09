import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTrajectoryWriter } from "@/headless/trajectory-writer";
import type { RecordedSend } from "@/headless/fake-sender";

/**
 * The trajectory is what makes a failed benchmark trial diagnosable rather than
 * indistinguishable from an infra flake, and a killed trial still scores zero — so
 * the properties worth pinning are the ones that decide whether the file is usable
 * at all when a run dies partway, and whether the numbers in it are real.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-traj-"));
  file = path.join(dir, "trajectory.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const META = {
  workspaceDir: "/ws",
  model: "deepseek-v4-flash",
  provider: "deepseek",
  mode: "build",
};

const send = (channel: string, payload: unknown): RecordedSend =>
  ({ channel, payload }) as RecordedSend;

/** Parse the file the way a consumer must: line-oriented, no whole-file JSON. */
function readLines(): Array<Record<string, any>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("headless trajectory writer", () => {
  it("opens with run_start carrying the schema version and run identity", () => {
    const w = createTrajectoryWriter(file, META);
    w.close();
    const [first] = readLines();
    expect(first.type).toBe("run_start");
    expect(first.schemaVersion).toBe(1);
    expect(first.model).toBe("deepseek-v4-flash");
    expect(first.provider).toBe("deepseek");
    expect(typeof first.ts).toBe("number");
  });

  it("keeps BOTH the running and done tool events, with real args and result", () => {
    const w = createTrajectoryWriter(file, META);
    w.onSend(
      send("chat:activity", {
        type: "tool_use",
        toolCallId: "call_1",
        toolName: "run_command",
        status: "running",
        toolArgs: { command: "pytest -q" },
        timestamp: 1000,
      }),
    );
    w.onSend(
      send("chat:activity", {
        type: "tool_use",
        toolCallId: "call_1",
        toolName: "run_command",
        status: "done",
        toolArgs: { command: "pytest -q" },
        resultText: "3 passed",
        timestamp: 2000,
      }),
    );
    w.close();

    const tools = readLines().filter((l) => l.type === "tool_use");
    // Collapsing the pair here would throw away the only record of when the tool
    // STARTED — a consumer that wants just the outcome can pair by toolCallId.
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ status: "running", ts: 1000 });
    expect(tools[1]).toMatchObject({
      status: "done",
      ts: 2000,
      resultText: "3 passed",
    });
    expect(tools[0].args).toEqual({ command: "pytest -q" });
    expect(tools.every((t) => t.toolName === "run_command")).toBe(true);
  });

  it("drops the UI token ESTIMATE and keeps only real provider usage", () => {
    const w = createTrajectoryWriter(file, META);
    // The throttled renderer ticker: inputTokens null, output GUESSED as chars/4.
    // Recording it would put invented numbers in a file used to report cost.
    w.onSend(
      send("chat:token-usage", { inputTokens: null, outputTokens: 250 }),
    );
    w.onSend(
      send("chat:token-usage", {
        inputTokens: 900,
        outputTokens: 120,
        totalTokens: 1020,
      }),
    );
    w.close();

    const usage = readLines().filter((l) => l.type === "token_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 900,
      outputTokens: 120,
      totalTokens: 1020,
    });
  });

  it("writes assistant text once at turn end, not once per chunk", () => {
    const w = createTrajectoryWriter(file, META);
    // Each chunk re-sends the FULL accumulated content. One line per chunk would
    // make the file grow with the square of the reply.
    for (const content of ["Loo", "Looking", "Looking at it"]) {
      w.onSend(
        send("chat:response:chunk", {
          messages: [{ role: "assistant", content }],
        }),
      );
    }
    expect(fs.readFileSync(file, "utf8").includes("Looking")).toBe(false);

    w.onSend(
      send("chat:response:end", { turnTokens: 1020, turnCostUsd: 0.004 }),
    );
    w.close();

    const texts = readLines().filter((l) => l.type === "assistant_text");
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("Looking at it");
  });

  it("splits reasoning out of the text and strips the inline tool markup", () => {
    const w = createTrajectoryWriter(file, META);
    w.onSend(
      send("chat:response:chunk", {
        messages: [
          {
            role: "assistant",
            content:
              "<think>check the tests first</think>Running them." +
              "<atlarix-tool-call>run_command</atlarix-tool-call>",
          },
        ],
      }),
    );
    w.onSend(send("chat:response:end", {}));
    w.close();

    const lines = readLines();
    const reasoning = lines.find((l) => l.type === "reasoning");
    const text = lines.find((l) => l.type === "assistant_text");
    expect(reasoning?.text).toBe("check the tests first");
    expect(text?.text).toBe("Running them.");
    // Tool activity is already reported structurally; leaving the markup here
    // would report every call twice.
    expect(text?.text).not.toContain("atlarix-tool-call");
  });

  it("carries the run's real cost and token totals on turn_end", () => {
    const w = createTrajectoryWriter(file, META);
    w.onSend(
      send("chat:response:end", {
        turnTokens: 4211,
        turnCostUsd: 0.0137,
        totalTokens: 51_000,
        reasoningTokens: 800,
        contextWindow: 1_000_000,
      }),
    );
    w.close();

    const end = readLines().find((l) => l.type === "turn_end");
    // These are exactly the fields a leaderboard's cost and token columns read.
    expect(end).toMatchObject({
      turnTokens: 4211,
      turnCostUsd: 0.0137,
      totalTokens: 51_000,
      reasoningTokens: 800,
    });
  });

  it("leaves a fully parseable file after every single event", () => {
    // The whole reason this streams instead of buffering: a SIGKILL leaves
    // whatever was already written, so the file has to be valid JSONL at every
    // point, not just after a graceful close.
    const w = createTrajectoryWriter(file, META);
    const events: RecordedSend[] = [
      send("chat:activity", {
        type: "tool_use",
        toolCallId: "c1",
        toolName: "read_file",
        status: "running",
        toolArgs: { path: "a.ts" },
      }),
      send("chat:token-usage", {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      }),
      send("chat:response:chunk", {
        messages: [{ role: "assistant", content: "hi" }],
      }),
      send("chat:response:error", { error: "boom" }),
    ];
    for (const e of events) {
      w.onSend(e);
      expect(() => readLines()).not.toThrow();
      const lines = readLines();
      expect(lines.every((l) => typeof l.type === "string")).toBe(true);
    }
    w.recordTermination("SIGTERM");
    expect(readLines().at(-1)).toMatchObject({
      type: "run_terminated",
      signal: "SIGTERM",
    });
    w.close();
  });

  it("strips tool markup as the live stream actually writes it — with attributes", () => {
    // The earlier version of this matched `<atlarix-tool-call>` only, so nothing
    // a real run emits was stripped and the whole serialized call block was
    // spliced into the prose as though the model had said it. Caught by an actual
    // DeepSeek run, not by a test — hence the real tag shape here.
    const w = createTrajectoryWriter(file, META);
    w.onSend(
      send("chat:response:chunk", {
        messages: [
          {
            role: "assistant",
            content:
              'Checking.<atlarix-tool-call tool="run_command" status="running">\n' +
              '{"command":"python3 test_stats.py"}\n</atlarix-tool-call>Done.',
          },
        ],
      }),
    );
    w.onSend(send("chat:response:end", {}));
    w.close();

    const text = readLines().find((l) => l.type === "assistant_text")?.text;
    expect(text).toBe("Checking.Done.");
    expect(text).not.toContain("atlarix-tool-call");
    expect(text).not.toContain("python3 test_stats.py");
  });

  it("drops the information-free duplicate completion a command emits", () => {
    // A real run announces a command's completion twice: the canonical event with
    // toolCallId + args, and a bare one with no id, no args and no result.
    // Recording the bare one invents a call that never happened — a trajectory
    // audit reads that as the agent having acted twice.
    const w = createTrajectoryWriter(file, META);
    w.onSend(
      send("chat:activity", {
        type: "tool_use",
        toolCallId: "call_00_real",
        toolName: "run_command",
        status: "done",
        toolArgs: { command: "python3 test_stats.py" },
      }),
    );
    w.onSend(
      send("chat:activity", {
        type: "tool_use",
        toolName: "run_command",
        status: "done",
        toolCallId: undefined,
        toolArgs: undefined,
      }),
    );
    w.close();

    const tools = readLines().filter((l) => l.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0].toolCallId).toBe("call_00_real");
  });

  it("redacts credentials, wherever in the event they appear", () => {
    // A leaderboard submission requires trajectories to be PUBLICLY readable, so
    // this file gets published — and a provider's own auth error quotes the key it
    // rejected. Observed for real: a bogus-key run wrote the rejected key
    // straight into the error line.
    const w = createTrajectoryWriter(file, META);
    const key = `sk-ant-${"A1b2C3d4E5f6G7h8J9k0"}`;
    w.onSend(
      send("chat:response:error", {
        error: `Authentication failed for ${key}`,
      }),
    );
    // Not just the error path: a command's own arguments carry them too.
    w.onSend(
      send("chat:activity", {
        type: "tool_use",
        toolCallId: "c1",
        toolName: "run_command",
        status: "done",
        toolArgs: {
          command: `curl -H "Authorization: Bearer ${key}" https://x`,
        },
        resultText: `wrote ${key} to .env`,
      }),
    );
    // And the model's own prose.
    w.onSend(
      send("chat:response:chunk", {
        messages: [{ role: "assistant", content: `Your key is ${key}` }],
      }),
    );
    w.onSend(send("chat:response:end", {}));
    w.close();

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(key);
    expect(raw).toContain("[redacted secret]");
    // Redacting the serialized line must not corrupt the JSON around it.
    expect(() => readLines()).not.toThrow();
    const lines = readLines();
    expect(lines.find((l) => l.type === "tool_use")?.toolName).toBe(
      "run_command",
    );
    expect(lines.find((l) => l.type === "assistant_text")?.text).toContain(
      "[redacted secret]",
    );
  });

  it("never lets a write failure take the run down", () => {
    const w = createTrajectoryWriter(file, META);
    w.close();
    // Post-close writes hit a closed fd. A benchmark result is worth more than
    // its trace, so this must be inert rather than throw.
    expect(() =>
      w.onSend(send("chat:response:end", { turnTokens: 1 })),
    ).not.toThrow();
    expect(() => w.recordRunEnd(true)).not.toThrow();
    expect(() => w.close()).not.toThrow();
  });
});
