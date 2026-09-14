/**
 * `read_attachment`, from the model's side.
 *
 * What is worth asserting is the SHAPE OF THE ANSWER, not just that one comes
 * back: a model that cannot tell there is more to read stops after page one,
 * and a model told only "not found" asks the user to attach a file that is
 * already attached — the single thing the system prompt tells it not to do.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { putAttachment } from "../attachments/store";
import { readAttachmentTool } from "./attachments";

const CTX = { windowId: 1, sessionId: "s1" };

beforeEach(() => {
  const data = new Map<string, unknown>();
  const area = {
    get: async (keys: string | string[] | null) => {
      if (keys === null) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    clear: async () => data.clear(),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area, sync: area },
  };
});

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("reading an attachment", () => {
  it("returns the file and says it is the whole thing", async () => {
    const id = await putAttachment("s1", {
      name: "notes.txt",
      type: "text/plain",
      body: "alpha\nbeta",
    });
    const out = await readAttachmentTool({ attachmentId: id }, CTX);
    expect(out.content).toContain("alpha\nbeta");
    expect(out.content).toContain("[End of file.]");
    expect(out.label).toBe("Read notes.txt");
  });

  it("spells out the next call rather than implying one", async () => {
    // The difference between a model that pages through a file and one that
    // reads page one, says "the file continues", and stops.
    const id = await putAttachment("s1", {
      name: "big.log",
      type: "text/plain",
      body: lines(5_000),
    });
    const out = await readAttachmentTool({ attachmentId: id }, CTX);
    expect(out.content).toContain('"attachmentId": "' + id + '"');
    expect(out.content).toContain('"offset": 2001');
    expect(out.content).toContain("more lines");
  });

  it("continues from an offset", async () => {
    const id = await putAttachment("s1", {
      name: "big.log",
      type: "text/plain",
      body: lines(5_000),
    });
    const out = await readAttachmentTool(
      { attachmentId: id, offset: 2001 },
      CTX,
    );
    expect(out.content).toContain("line 2001");
    expect(out.content).not.toContain("line 2000\n");
    expect(out.label).toContain("2001");
  });

  it("reaches the end of a file that would once have been truncated", async () => {
    const id = await putAttachment("s1", {
      name: "huge.csv",
      type: "text/csv",
      body: lines(60_000),
    });
    const out = await readAttachmentTool(
      { attachmentId: id, offset: 59_000 },
      CTX,
    );
    expect(out.content).toContain("line 60000");
    expect(out.content).toContain("[End of file.]");
  });
});

describe("when the model gets the id wrong", () => {
  it("lists the real ids instead of just refusing", async () => {
    const id = await putAttachment("s1", {
      name: "notes.txt",
      type: "text/plain",
      body: "hi",
    });
    const out = await readAttachmentTool({ attachmentId: "nope" }, CTX);
    expect(out.content).toContain("notes.txt");
    expect(out.content).toContain(id);
  });

  it("does the same when no id was passed at all", async () => {
    await putAttachment("s1", { name: "a.txt", type: "text/plain", body: "hi" });
    const out = await readAttachmentTool({}, CTX);
    expect(out.content).toContain("a.txt");
  });

  it("says plainly when nothing is attached, and not to ask again", async () => {
    const out = await readAttachmentTool({ attachmentId: "x" }, CTX);
    expect(out.content).toMatch(/nothing is attached/i);
    expect(out.label).toBe("No attachments");
  });
});

describe("scope", () => {
  it("cannot read another conversation's file", async () => {
    // `sessionId` comes from the harness, never from the model, so this is not
    // something a page's text can talk its way around.
    const id = await putAttachment("s2", {
      name: "other.txt",
      type: "text/plain",
      body: "private",
    });
    await putAttachment("s1", { name: "mine.txt", type: "text/plain", body: "ok" });

    const out = await readAttachmentTool({ attachmentId: id }, CTX);
    expect(out.content).not.toContain("private");
    expect(out.content).toContain("no attachment with id");
  });
});
