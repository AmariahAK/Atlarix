/**
 * D1 — the "Secret handling" guidance must be present in BOTH base prompt files
 * (AGENTS_COMPACT.md is loaded for compact contexts, AGENTS_MODE_BASE.md for the
 * mode-scoped path), so the behavior applies on every turn regardless of mode.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = ["AGENTS_COMPACT.md", "AGENTS_MODE_BASE.md"];

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
