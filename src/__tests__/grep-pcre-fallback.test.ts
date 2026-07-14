import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ToolRegistry } from "@/lib/tools";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression: a regex the default (Rust) ripgrep engine can't parse — e.g. a
 * lookahead like `use(?=.*Json)` — used to be swallowed by `catch { return [] }`
 * and reported as "no matches", so the model (observed with deepseek-v4-pro)
 * concluded "grep has an issue" when matches actually existed. grep now retries
 * with `--pcre2` and surfaces genuine errors instead of an empty result.
 */
describe("grep — PCRE2 fallback + honest errors", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "atlarix-grep-"));
    writeFileSync(join(dir, "a.rs"), "use JsonObject;\nuse Arc;\nlet x = 1;\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds matches for a lookahead pattern via the PCRE2 retry", async () => {
    const res: any = await ToolRegistry.execute("grep", {
      pattern: "use(?=.*Json)",
      workspace: dir,
    });
    expect(res.success).toBe(true);
    expect(JSON.stringify(res)).toContain("JsonObject");
  });

  it("reports 'no matches' (not an error) for a valid pattern with zero hits", async () => {
    const res: any = await ToolRegistry.execute("grep", {
      pattern: "zzz_no_such_symbol",
      workspace: dir,
    });
    expect(res.success).toBe(true);
    expect(JSON.stringify(res)).toMatch(/no matches/i);
  });

  it("surfaces a real error for an unparseable pattern (invalid in both engines)", async () => {
    const res: any = await ToolRegistry.execute("grep", {
      pattern: "(", // unbalanced group — invalid in Rust regex AND PCRE2
      workspace: dir,
    });
    expect(res.success).toBe(false);
  });
});
