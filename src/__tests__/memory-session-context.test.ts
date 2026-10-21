/**
 * Project memory on the user row: the index once per session, the change notice,
 * recall once per note — all derived from the rows the session saved.
 *
 * Each test drives `buildMemoryTurnContext` the way chat_stream_handlers does: with
 * the conversation BEFORE the message, then folds the result into that message's
 * `modelContent` with `withMemoryContext`, so the next call sees exactly what a
 * saved-and-replayed session would.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MEMORY_INDEX_MAX_LINES,
  RECALL_NOTE_MAX_BYTES,
  buildMemoryTurnContext,
  withMemoryContext,
} from "@/lib/memory/session-context";
import { __clearKnownMemoryIndexes } from "@/lib/memory/index-state";
import { recordFileWrite } from "@/lib/tools/file-read-log";
import type { RecallCandidate } from "@/lib/memory/recall";
import {
  COMPACTION_MARKER_KIND,
  COMPACTION_SUMMARY_PREFIX,
} from "@/lib/context/compaction";
import {
  memoryDirFor,
  memoryIndexPathFor,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";

type Row = {
  role: string;
  content: string;
  modelContent?: string | null;
  kind?: string;
};

let root = "";
let workspace = "";
const SCOPE = "sess:test-session";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-memctx-root-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-memctx-ws-"));
  setAgentMemoryRootOverride(root);
  delete process.env.ATLARIX_MEMORY;
  __clearKnownMemoryIndexes();
});

afterEach(async () => {
  setAgentMemoryRootOverride(null);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeNoteFile(file: string, body: string, description = `about ${file}`) {
  const dir = memoryDirFor(workspace);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, file),
    `---\nname: ${file.replace(/\.md$/, "")}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}\n`,
  );
}

async function writeIndex(lines: string[]) {
  await fs.mkdir(memoryDirFor(workspace), { recursive: true });
  await fs.writeFile(memoryIndexPathFor(workspace), `${lines.join("\n")}\n`);
}

async function seed() {
  await writeNoteFile("supabase-projects.md", "Two separate projects.");
  await writeNoteFile("deploy-order.md", "Deploy the proxy first.");
  await writeIndex([
    "# Memory Index",
    "",
    "- [Supabase projects](supabase-projects.md) — two of them",
    "- [Deploy order](deploy-order.md) — proxy first",
  ]);
}

/** One user message: build its memory context, append it as the saved row would be. */
async function send(
  history: Row[],
  text: string,
  select: (a: { candidates: RecallCandidate[] }) => Promise<string[]> = async () => [],
): Promise<{ reminders: string; history: Row[] }> {
  const reminders = await buildMemoryTurnContext({
    workspacePath: workspace,
    scope: SCOPE,
    history,
    userText: text,
    select: (a) => select(a),
  });
  const modelContent = reminders ? withMemoryContext(text, reminders) : null;
  return {
    reminders,
    history: [
      ...history,
      { role: "user", content: text, modelContent },
      { role: "assistant", content: "ok" },
    ],
  };
}

describe("the index — once per session, saved with the row", () => {
  it("rides the first user message, ahead of the user's own text", async () => {
    await seed();
    const { reminders, history } = await send([], "hello");
    expect(reminders).toContain(
      `Contents of ${memoryIndexPathFor(workspace)} (project memory, persists across sessions):`,
    );
    expect(reminders).toContain("- [Deploy order](deploy-order.md) — proxy first");
    expect(history[0]!.modelContent!.endsWith("\n\nhello")).toBe(true);
    expect(history[0]!.modelContent!.startsWith("<system-reminder>")).toBe(true);
  });

  it("is not attached again on the next message", async () => {
    await seed();
    const first = await send([], "hello");
    const second = await send(first.history, "and now?");
    expect(second.reminders).not.toContain("Contents of");
    expect(second.reminders).toBe("");
  });

  it("is read back from the saved rows, so a restart does not re-attach it", async () => {
    await seed();
    const first = await send([], "hello");
    __clearKnownMemoryIndexes(); // a new process: nothing in memory but the rows
    const second = await send(first.history, "after restart");
    expect(second.reminders).toBe("");
  });

  it("is attached again on the first message after a compaction", async () => {
    await seed();
    const first = await send([], "hello");
    const compacted: Row[] = [
      ...first.history,
      {
        role: "user",
        content: `${COMPACTION_SUMMARY_PREFIX} gen=1\nsummary of the above`,
        kind: COMPACTION_MARKER_KIND,
      },
      { role: "assistant", content: "ok" },
    ];
    const next = await send(compacted, "carry on");
    expect(next.reminders).toContain("Contents of");
    // …and only that once.
    const after = await send(next.history, "more");
    expect(after.reminders).not.toContain("Contents of");
  });

  it("is never attached with ATLARIX_MEMORY=off", async () => {
    await seed();
    process.env.ATLARIX_MEMORY = "off";
    try {
      expect((await send([], "hello")).reminders).toBe("");
    } finally {
      delete process.env.ATLARIX_MEMORY;
    }
  });
});

describe("the index cap", () => {
  it(`shows ${MEMORY_INDEX_MAX_LINES} lines and asks for consolidation past it`, async () => {
    await writeNoteFile("a.md", "fact");
    const lines = Array.from({ length: 250 }, (_, i) => `- [Note ${i}](n${i}.md) — hook ${i}`);
    await writeIndex(lines);
    const { reminders } = await send([], "hello");
    expect(reminders).toContain("- [Note 199](n199.md)");
    expect(reminders).not.toContain("- [Note 200](n200.md)");
    expect(reminders).toMatch(/Consolidate it/);
  });

  it("cuts on a line boundary past 25 KB", async () => {
    await writeNoteFile("a.md", "fact");
    const long = "x".repeat(300);
    const lines = Array.from({ length: 150 }, (_, i) => `- [N${i}](n${i}.md) — ${long}`);
    await writeIndex(lines);
    const { reminders } = await send([], "hello");
    const shown = reminders.split("\n").filter((l) => l.startsWith("- [N"));
    expect(shown.length).toBeLessThan(150);
    expect(shown.every((l) => l.endsWith(long))).toBe(true);
    expect(Buffer.byteLength(shown.join("\n"))).toBeLessThanOrEqual(25 * 1024);
    expect(reminders).toMatch(/Consolidate it/);
  });

  it("adds no consolidation line under the cap", async () => {
    await seed();
    expect((await send([], "hello")).reminders).not.toMatch(/Consolidate/);
  });
});

describe("MEMORY.md changed on disk", () => {
  it("tells the session what changed, once", async () => {
    await seed();
    const first = await send([], "hello");
    await writeIndex([
      "# Memory Index",
      "",
      "- [Supabase projects](supabase-projects.md) — two of them",
      "- [Release gate](release-gate.md) — owner green-lights",
    ]);
    const second = await send(first.history, "next");
    expect(second.reminders).toContain("MEMORY.md changed on disk since you last read it");
    expect(second.reminders).toContain("+ - [Release gate](release-gate.md) — owner green-lights");
    expect(second.reminders).toContain("- - [Deploy order](deploy-order.md) — proxy first");
    expect(second.reminders).not.toContain("Contents of");

    // The notice itself becomes the baseline — from the rows, not from memory.
    __clearKnownMemoryIndexes();
    const third = await send(second.history, "again");
    expect(third.reminders).toBe("");
  });

  it("says nothing about the session's OWN edit_file write to the index", async () => {
    await seed();
    const first = await send([], "hello");
    const next = [
      "# Memory Index",
      "",
      "- [Supabase projects](supabase-projects.md) — two of them",
      "- [Deploy order](deploy-order.md) — proxy first",
      "- [New](new.md) — written by this session",
    ].join("\n");
    await fs.writeFile(memoryIndexPathFor(workspace), next);
    // What build-branch does when an edit_file write lands.
    recordFileWrite(SCOPE, memoryIndexPathFor(workspace), next);
    const second = await send(first.history, "next");
    expect(second.reminders).not.toContain("changed on disk");
  });

  it("re-attaches the whole index when the change is too large for a notice", async () => {
    await seed();
    const first = await send([], "hello");
    await writeIndex(Array.from({ length: 60 }, (_, i) => `- [M${i}](m${i}.md) — hook`));
    const second = await send(first.history, "next");
    expect(second.reminders).toContain("Contents of");
    expect(second.reminders).not.toContain("changed on disk");
  });
});

describe("recall — up to five notes, once per session", () => {
  it("attaches the chosen note in full, with its age, as background", async () => {
    await seed();
    let seen: RecallCandidate[] = [];
    const { reminders } = await send([], "how do I deploy?", async ({ candidates }) => {
      seen = candidates;
      return ["deploy-order.md"];
    });
    expect(seen.map((c) => c.file).sort()).toEqual(["deploy-order.md", "supabase-projects.md"]);
    expect(seen.find((c) => c.file === "deploy-order.md")).toMatchObject({
      description: "about deploy-order.md",
      type: "project",
      ageDays: 0,
    });
    const abs = path.join(memoryDirFor(workspace), "deploy-order.md");
    expect(reminders).toContain(
      `Recalled project memory \`${abs}\` (background, written today; verify before relying on it):`,
    );
    expect(reminders).toContain("Deploy the proxy first.");
    expect(reminders).not.toContain("Two separate projects.");
  });

  it("never offers a note already recalled in this session, unless it changed", async () => {
    await seed();
    const first = await send([], "deploy?", async () => ["deploy-order.md"]);
    let offered: string[] = [];
    const second = await send(first.history, "deploy again?", async ({ candidates }) => {
      offered = candidates.map((c) => c.file);
      return ["deploy-order.md"];
    });
    expect(offered).toEqual(["supabase-projects.md"]);
    expect(second.reminders).not.toContain("Recalled project memory");

    await writeNoteFile("deploy-order.md", "Deploy the proxy first, then the app.");
    await send(second.history, "and now?", async ({ candidates }) => {
      offered = candidates.map((c) => c.file);
      return [];
    });
    expect(offered).toContain("deploy-order.md");
  });

  it("is derived from the rows, so it holds across a restart", async () => {
    await seed();
    const first = await send([], "deploy?", async () => ["deploy-order.md"]);
    __clearKnownMemoryIndexes();
    let offered: string[] = [];
    await send(first.history, "deploy again?", async ({ candidates }) => {
      offered = candidates.map((c) => c.file);
      return [];
    });
    expect(offered).not.toContain("deploy-order.md");
  });

  it("makes no call when every note was already recalled", async () => {
    await seed();
    const first = await send([], "both", async () => ["deploy-order.md", "supabase-projects.md"]);
    let called = false;
    await send(first.history, "again", async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
  });

  it(`cuts a long note at ${RECALL_NOTE_MAX_BYTES / 1024} KB and says where the rest is`, async () => {
    await seed();
    await writeNoteFile("big.md", "y".repeat(10_000));
    const { reminders } = await send([], "big", async () => ["big.md"]);
    expect(reminders).toMatch(/cut at 4 KB; read_file the note for the rest/);
    expect(reminders.length).toBeLessThan(10_000);
  });

  it("ignores names the selector made up", async () => {
    await seed();
    const { reminders } = await send([], "x", async () => ["invented.md"]);
    expect(reminders).not.toContain("Recalled project memory");
  });

  it("a failed recall keeps the index and never throws", async () => {
    await seed();
    const { reminders } = await send([], "hello", async () => {
      throw new Error("provider down");
    });
    expect(reminders).toContain("Contents of");
    expect(reminders).not.toContain("Recalled project memory");
  });

  it("uses the note's stamped metadata.modified for its age", async () => {
    const dir = memoryDirFor(workspace);
    await fs.mkdir(dir, { recursive: true });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await fs.writeFile(
      path.join(dir, "old.md"),
      `---\nname: old\ndescription: an old fact\nmetadata:\n  type: user\n  modified: ${tenDaysAgo}\n---\n\nold\n`,
    );
    let age = -1;
    const { reminders } = await send([], "old", async ({ candidates }) => {
      age = candidates[0]!.ageDays;
      return ["old.md"];
    });
    expect(age).toBe(10);
    expect(reminders).toContain("written 10 days ago");
  });
});

describe("display", () => {
  it("the CLI shows a pasted message without the memory reminders", async () => {
    const { stripSystemReminders } = await import("@/lib/streaming/system-reminder");
    await seed();
    const { history } = await send([], "my pasted text");
    expect(stripSystemReminders(history[0]!.modelContent!)).toBe("my pasted text");
  });
});
