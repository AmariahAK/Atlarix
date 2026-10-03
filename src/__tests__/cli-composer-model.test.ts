import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSubmission,
  classifyPaste,
  freshCounters,
  labelFor,
  pastedPath,
  shouldCollapsePaste,
  type FsProbe,
} from "@/cli/composer/model";

const fakeFs = (entries: Record<string, "file" | "dir">): FsProbe => ({
  stat: (p) => (entries[p] ? { isDirectory: () => entries[p] === "dir" } : null),
});

describe("pastes", () => {
  it("collapses at 3 lines or 150 characters, like opencode", () => {
    expect(shouldCollapsePaste("a\nb")).toBe(false);
    expect(shouldCollapsePaste("a\nb\nc")).toBe(true);
    expect(shouldCollapsePaste("x".repeat(150))).toBe(false);
    expect(shouldCollapsePaste("x".repeat(151))).toBe(true);
  });

  it("numbers pastes per draft and labels them with their line count", () => {
    const c = freshCounters();
    const a = classifyPaste("1\n2\n3", c, { fs: fakeFs({}) });
    const b = classifyPaste("1\n2\n3\n4", c, { fs: fakeFs({}) });
    expect(labelFor(a!)).toBe("[Pasted text #1 +3 lines]");
    expect(labelFor(b!)).toBe("[Pasted text #2 +4 lines]");
  });

  it("a short paste stays plain text", () => {
    expect(classifyPaste("hello", freshCounters(), { fs: fakeFs({}) })).toBeNull();
  });
});

describe("dropped and pasted paths", () => {
  it("reads the spellings terminals use for a dragged file", () => {
    expect(pastedPath("/Users/me/My\\ File.pdf")).toBe("/Users/me/My File.pdf");
    expect(pastedPath("'/Users/me/My File.pdf'")).toBe("/Users/me/My File.pdf");
    expect(pastedPath("file:///Users/me/My%20File.pdf")).toBe("/Users/me/My File.pdf");
    expect(pastedPath("~/x.txt")).toBe(path.join(os.homedir(), "x.txt"));
    expect(pastedPath("./a.ts", "/w")).toBe("/w/a.ts");
    expect(pastedPath("just words")).toBeNull();
    expect(pastedPath("/a\n/b")).toBeNull();
  });

  it("an image becomes [Image #N], a folder [Folder …], anything else [File …]", () => {
    const fs = fakeFs({ "/p/shot.png": "file", "/p/docs": "dir", "/p/spec.pdf": "file" });
    const c = freshCounters();
    expect(labelFor(classifyPaste("/p/shot.png", c, { fs })!)).toBe("[Image #1]");
    expect(labelFor(classifyPaste("/p/docs", c, { fs })!)).toBe("[Folder /p/docs]");
    expect(labelFor(classifyPaste("/p/spec.pdf", c, { fs })!)).toBe("[File /p/spec.pdf]");
  });

  it("a path that does not exist is just text", () => {
    expect(classifyPaste("/nope/x.png", freshCounters(), { fs: fakeFs({}) })).toBeNull();
  });
});

describe("submitting", () => {
  it("expands pastes for the model and keeps labels for the transcript", () => {
    const paste = { kind: "paste" as const, n: 1, text: "line1\nline2\nline3" };
    const label = labelFor(paste);
    const s = buildSubmission(`fix this ${label} please`, [{ label, attachment: paste }]);
    expect(s.prompt).toBe("fix this line1\nline2\nline3 please");
    expect(s.display).toBe(`fix this ${label} please`);
  });

  it("gives the model absolute paths for files and folders, and sends images as parts", () => {
    const home = os.homedir();
    const file = { kind: "file" as const, path: path.join(home, "spec.pdf") };
    const img = { kind: "image" as const, n: 1, path: "/p/a.png", mime: "image/png" };
    const s = buildSubmission(`see ${labelFor(file)} and ${labelFor(img)}`, [
      { label: labelFor(file), attachment: file },
      { label: labelFor(img), attachment: img },
    ]);
    expect(labelFor(file)).toBe("[File ~/spec.pdf]");
    expect(s.prompt).toContain(`[File ${path.join(home, "spec.pdf")}]`);
    expect(s.prompt).toContain("[Image #1]");
    expect(s.images).toEqual([{ label: "[Image #1]", path: "/p/a.png", mime: "image/png" }]);
  });

  it("drops a placeholder the user deleted, image included", () => {
    const img = { kind: "image" as const, n: 1, path: "/p/a.png", mime: "image/png" };
    const s = buildSubmission("never mind", [{ label: labelFor(img), attachment: img }]);
    expect(s.images).toEqual([]);
  });
});
