/**
 * Files the model built, in memory for the life of the panel.
 *
 * THREE PROPERTIES, each with a failure that is quiet rather than loud:
 *
 *  - **A rebuilt file does not replace the one already on screen.** Unlike an
 *    attachment, whose id is a hash of its content, every file gets a fresh id
 *    — so a corrected spreadsheet appears beside the first rather than changing
 *    a card the user has already looked at.
 *  - **The note is a contract.** It is the only durable trace: the bytes die
 *    with the panel, so on a reopened conversation the names in this sentence
 *    are the only thing left to draw a card from. A name with a comma or a
 *    space in it must survive the round trip, because `safeName` permits both.
 *  - **A conversation cannot read another one's files.** The same boundary
 *    attachments and relics get from their key prefix, here from the Map.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SESSION_BYTES,
  dropAllFiles,
  dropSessionFiles,
  findFileByName,
  formatSize,
  getFile,
  listFiles,
  madeFilesNote,
  putFiles,
  readMadeFilesNote,
} from "./store";

function file(name: string, size = 4, mime = "text/plain") {
  return { name, mime, bytes: new Uint8Array(size) };
}

beforeEach(() => {
  dropAllFiles();
});

describe("keeping what a run made", () => {
  it("gives two files of the same name two ids", () => {
    const [first] = putFiles("s1", [file("report.csv")]);
    const [second] = putFiles("s1", [file("report.csv", 8)]);

    expect(first!.id).not.toBe(second!.id);
    expect(getFile("s1", first!.id)?.bytes.length).toBe(4);
    expect(getFile("s1", second!.id)?.bytes.length).toBe(8);
  });

  it("resolves a name to the MOST RECENT file with it", () => {
    putFiles("s1", [file("report.csv", 4)]);
    putFiles("s1", [file("report.csv", 8)]);
    expect(findFileByName("s1", "report.csv")?.bytes.length).toBe(8);
  });

  it("keeps conversations apart", () => {
    const [made] = putFiles("s1", [file("a.csv")]);
    expect(getFile("s2", made!.id)).toBeNull();
    expect(findFileByName("s2", "a.csv")).toBeNull();
    expect(listFiles("s2")).toEqual([]);
  });

  it("evicts the OLDEST when a conversation runs past its budget", () => {
    // Refusing instead would fail the tool for someone who had simply been
    // productive, and the newest file is the one they just asked for.
    const big = Math.floor(MAX_SESSION_BYTES / 2) + 1;
    putFiles("s1", [file("first.bin", big)]);
    putFiles("s1", [file("second.bin", big)]);
    putFiles("s1", [file("third.bin", 10)]);

    expect(listFiles("s1").map((f) => f.name)).toEqual([
      "second.bin",
      "third.bin",
    ]);
  });
});

describe("forgetting", () => {
  it("drops one conversation and leaves the others", () => {
    putFiles("s1", [file("a.csv")]);
    putFiles("s2", [file("b.csv")]);
    dropSessionFiles(["s1"]);
    expect(listFiles("s1")).toEqual([]);
    expect(listFiles("s2")).toHaveLength(1);
  });

  it("drops everything, including conversations nobody listed", () => {
    // "Erase everything" has to mean everything. A file made in a conversation
    // that never reached the session index would otherwise outlive the one
    // gesture whose whole promise is that nothing does.
    putFiles("never-indexed", [file("a.csv")]);
    dropAllFiles();
    expect(listFiles("never-indexed")).toEqual([]);
  });
});

describe("the note, which is the only thing that survives a reload", () => {
  it("round-trips names that contain the characters safeName allows", () => {
    const made = putFiles("s1", [
      file("Q3 report, final.csv"),
      file("a|b.txt"),
    ]);
    const names = readMadeFilesNote(madeFilesNote(made));
    expect(names).toEqual(["Q3 report, final.csv", "a|b.txt"]);
  });

  it("tells the model the user already has them", () => {
    const note = madeFilesNote(putFiles("s1", [file("a.csv")]));
    expect(note).toMatch(/download from this conversation/);
    expect(note).toMatch(/Do not paste the contents/);
  });

  it("is null for any other tool result", () => {
    expect(readMadeFilesNote("Read a page with 12 controls.")).toBeNull();
    expect(readMadeFilesNote('Saved "Chart" as a relic [id abc].')).toBeNull();
  });
});

describe("formatSize", () => {
  it("reads as a person would say it", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
