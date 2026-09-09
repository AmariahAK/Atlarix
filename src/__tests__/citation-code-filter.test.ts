/**
 * Citations should point at pages a person can read, not at raw source files.
 *
 * Web search legitimately turns up code on GitHub — `packages/core/src/tools/ls.ts`,
 * `app/agent/ls_tool.py` — and those crowded out the articles and docs that actually
 * answered the question (one observed turn had 20 citations, most of them code).
 *
 * Worth stating because it's a natural misreading: the app never cites files it read
 * locally. Citations only ever come from the web-search tool set. These are web
 * results that happen to point AT code.
 */

import { describe, expect, it } from "vitest";
import { isCodeFileSourceUrl } from "@/lib/chat/citation-sources";

describe("isCodeFileSourceUrl — dropped", () => {
  it.each([
    "https://github.com/o/r/blob/main/packages/core/src/tools/ls.ts",
    "https://github.com/o/r/blob/main/app/agent/ls_tool.py",
    "https://github.com/o/r/blob/main/src/index.tsx",
    "https://github.com/o/r/blob/main/main.go",
    "https://github.com/o/r/blob/main/lib.rs",
    "https://raw.githubusercontent.com/o/r/main/config.yml",
    "https://gitlab.com/o/r/-/blob/main/settings.json",
    "https://example.com/scripts/build.sh",
    "https://example.com/styles/app.css",
    "https://example.com/db/schema.sql",
  ])("drops %s", (url) => {
    expect(isCodeFileSourceUrl(url)).toBe(true);
  });
});

describe("isCodeFileSourceUrl — kept", () => {
  it.each([
    // Documentation is frequently the real answer — never dropped.
    "https://github.com/o/r/blob/main/README.md",
    "https://github.com/o/r/blob/main/docs/TELEPHONY.md",
    "https://example.com/guide.mdx",
    "https://example.com/notes.rst",
    "https://example.com/changes.txt",
    // Ordinary pages.
    "https://www.mintlify.com/lukilabs/craft-agents-oss/features/permissions/modes",
    "https://docs.nanocollective.org/development-modes",
    "https://bbc.co.uk/news/some-story",
    // github.com hosts plenty of citable non-code pages, so the whole domain must
    // NOT be excluded.
    "https://github.com/o/r/issues/42",
    "https://github.com/o/r/discussions/7",
    "https://github.com/adrianwedd/TEL3SIS",
    // Trailing slash / no filename.
    "https://example.com/docs/",
    "https://example.com",
  ])("keeps %s", (url) => {
    expect(isCodeFileSourceUrl(url)).toBe(false);
  });

  it("keeps a dotted path segment that isn't a file extension", () => {
    expect(isCodeFileSourceUrl("https://example.com/v1.2/overview")).toBe(
      false,
    );
  });

  it("is case-insensitive about the extension", () => {
    expect(
      isCodeFileSourceUrl("https://github.com/o/r/blob/main/Main.PY"),
    ).toBe(true);
  });

  it("does not throw on a malformed url", () => {
    expect(isCodeFileSourceUrl("not a url")).toBe(false);
    expect(isCodeFileSourceUrl("")).toBe(false);
  });

  it("ignores a query string when judging the extension", () => {
    expect(isCodeFileSourceUrl("https://example.com/page?file=a.ts")).toBe(
      false,
    );
  });
});
