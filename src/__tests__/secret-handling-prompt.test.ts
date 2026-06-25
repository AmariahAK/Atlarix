/**
 * D1 — the "Secret handling" guidance must be present in the single base prompt
 * file (AGENTS.md, loaded on every dispatch for both live work modes and
 * headless), so the behavior applies on every turn regardless of mode.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = ["AGENTS.md"];

describe("Secret handling prompt section (D1)", () => {
  for (const file of FILES) {
    it(`${file} contains the Secret handling section + core rules`, () => {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      expect(text).toContain("## Secret handling");
      expect(text).toMatch(/\.env|\.envrc/);
      expect(text.toLowerCase()).toContain("rotate");
      expect(text.toLowerCase()).toMatch(/prod/);
      expect(text.toLowerCase()).toMatch(/never (print|echo)/);
    });
  }
});
