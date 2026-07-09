/**
 * command-default-allow — quote-aware segmentation + the default read-only set.
 * The gate composes these with per-segment user rules (see command-permission-gate).
 */
import { describe, expect, it } from "vitest";
import {
  quoteAwareSegments,
  isDefaultAllowedSegment,
} from "@/lib/command-default-allow";

describe("quoteAwareSegments", () => {
  it("splits pipeline/chain operators", () => {
    expect(quoteAwareSegments("ls | grep x")).toEqual(["ls", "grep x"]);
    expect(quoteAwareSegments("cat a && grep b")).toEqual(["cat a", "grep b"]);
    expect(quoteAwareSegments("a; b; c")).toEqual(["a", "b", "c"]);
  });

  it("does NOT split inside quotes (a regex `|` is not a pipe)", () => {
    expect(quoteAwareSegments("grep 'a|b' src")).toEqual(["grep 'a|b' src"]);
    expect(quoteAwareSegments('grep "x;y" f')).toEqual(['grep "x;y" f']);
  });

  it("does NOT split a redirect fd operator (`2>&1`)", () => {
    expect(quoteAwareSegments("ls 2>&1 | head")).toEqual(["ls 2>&1", "head"]);
    expect(quoteAwareSegments("cmd &>/dev/null")).toEqual(["cmd &>/dev/null"]);
  });

  it("strips benign leading cd/time/nice wrappers, drops empties", () => {
    expect(quoteAwareSegments("cd src && grep foo")).toEqual(["grep foo"]);
    expect(quoteAwareSegments("time ls -la")).toEqual(["ls -la"]);
    expect(quoteAwareSegments("ls |")).toEqual(["ls"]);
  });

  it("returns null for unsafe-to-segment commands (substitution / unbalanced quotes)", () => {
    expect(quoteAwareSegments('echo "$(whoami)"')).toBeNull();
    expect(quoteAwareSegments("grep 'unbalanced")).toBeNull();
  });
});

describe("isDefaultAllowedSegment", () => {
  it.each([
    "ls -la",
    "grep -rn foo src",
    "find . -name '*.ts'",
    "cat src/index.ts",
    "head -n5 file",
    "echo ok",
    "sort file",
    "wc -l file",
    "grep x 2>/dev/null",
  ])("default-allowed: %s", (seg) => {
    expect(isDefaultAllowedSegment(seg)).toBe(true);
  });

  it.each([
    "sh -c x", // not a reader
    "tee out", // writer
    "awk '{print}'", // can exec/write
    "grep x > out", // file redirect
    "echo $HOME", // var expansion
    "cat `whoami`", // substitution
    "find . -delete", // find action
    "find . -exec rm {} \\;",
    "grep KEY .env", // secret path
    "cat ~/.ssh/id_rsa", // credential path
    "npm test", // not in the set
    "",
  ])("not default-allowed: %s", (seg) => {
    expect(isDefaultAllowedSegment(seg)).toBe(false);
  });
});
