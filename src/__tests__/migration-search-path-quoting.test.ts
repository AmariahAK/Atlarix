/**
 * `SET search_path TO 'public, extensions'` is ONE schema named
 * "public, extensions", which does not exist. public.refresh_disposable_domains
 * had it, so the weekly blocklist re-pull failed on its first run (2026-11-02
 * 04:17 UTC: relation "disposable_email_domains" does not exist).
 *
 * The newest definition of every function in supabase/migrations must name its
 * schemas unquoted (`TO public, extensions`) or one per quoted name
 * (`TO 'public', 'extensions'`).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../../supabase/migrations");

function latestDefinitions(): Map<string, { file: string; searchPath: string | null }> {
  const out = new Map<string, { file: string; searchPath: string | null }>();
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(([\s\S]*?)\$(\w*)\$/gi;
    for (const m of sql.matchAll(re)) {
      const head = m[2]!;
      const sp = /SET\s+search_path\s*(?:TO|=)\s*([^\n]*?)(?:\s+AS\s*$|\s*$)/im.exec(head);
      out.set(m[1]!.toLowerCase().replace(/"/g, ""), { file, searchPath: sp ? sp[1]!.trim() : null });
    }
  }
  return out;
}

describe("migrations: search_path names real schemas", () => {
  it("no function's newest definition quotes a comma list as one schema", () => {
    const bad = [...latestDefinitions()]
      .filter(([, d]) => d.searchPath !== null && /'[^']*,[^']*'/.test(d.searchPath))
      .map(([name, d]) => `${name} (${d.file}): ${d.searchPath}`);
    expect(bad).toEqual([]);
  });

  it("the guard sees refresh_disposable_domains", () => {
    expect(latestDefinitions().has("public.refresh_disposable_domains")).toBe(true);
  });
});
