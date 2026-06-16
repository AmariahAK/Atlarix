import { describe, expect, it } from "vitest";
import { detectTrigger } from "@/components/chat/ComposerAutocomplete";

/** Caret defaults to end-of-string for these cases. */
const at = (s: string) => detectTrigger(s, s.length);

describe("detectTrigger — composer `@` file/folder autocomplete", () => {
  it("detects an @ mention at message start", () => {
    expect(at("@web")).toEqual({ query: "web", start: 0, end: 4 });
  });

  it("detects an @ mention after whitespace", () => {
    const r = at("look at @src");
    expect(r?.query).toBe("src");
    expect(r?.start).toBe(8);
  });

  it("detects an empty @ trigger (just typed `@`)", () => {
    expect(at("@")).toEqual({ query: "", start: 0, end: 1 });
  });

  it("strips the optional file:/dir: prefixes when matching", () => {
    expect(at("@file:src/index")?.query).toBe("src/index");
    expect(at("@dir:src")?.query).toBe("src");
  });

  it("no longer triggers on `/` (slash commands removed)", () => {
    expect(at("/dep")).toBeNull();
    expect(at("/")).toBeNull();
    expect(at("hello /rev")).toBeNull();
  });

  it("does NOT trigger mid-word (e.g. a path or email)", () => {
    expect(at("src/index.ts")).toBeNull();
    expect(at("foo@bar")).toBeNull();
  });

  it("does not trigger on plain text or once the token is closed by a space", () => {
    expect(at("just some prose")).toBeNull();
    expect(at("@file:web ")).toBeNull();
  });

  it("uses the caret position, not the whole string", () => {
    // caret right after the "@sr" — trailing text is ignored
    expect(detectTrigger("@src later", 4)?.query).toBe("src");
  });
});
