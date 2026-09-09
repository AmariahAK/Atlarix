#!/usr/bin/env npx tsx
/**
 * Lightweight dead-code audit: list TS exports with zero importers (rg-based).
 * Run: npx tsx scripts/audit-dead-code.ts
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "src");
const SKIP_DIRS = new Set(["__tests__", "node_modules", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name) && !ent.name.endsWith(".d.ts"))
      out.push(p);
  }
  return out;
}

const exportRe =
  /^export (?:async )?(?:function|const|class|type|interface|enum) (\w+)/gm;

const candidates: { file: string; name: string }[] = [];
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, "utf8");
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(text))) {
    candidates.push({
      file: path.relative(path.join(__dirname, ".."), file),
      name: m[1]!,
    });
  }
}

const unused: typeof candidates = [];
for (const { file, name } of candidates) {
  try {
    const hits = execSync(
      `rg -l --glob '!**/__tests__/**' '\\b${name}\\b' src`,
      { cwd: path.join(__dirname, ".."), encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const importers = hits.filter((h) => h !== file);
    if (importers.length === 0) unused.push({ file, name });
  } catch {
    unused.push({ file, name });
  }
}

console.log(
  `Scanned ${candidates.length} exports; ${unused.length} with no importers:\n`,
);
for (const u of unused.slice(0, 80)) {
  console.log(`  ${u.name}  (${u.file})`);
}
if (unused.length > 80) console.log(`  … and ${unused.length - 80} more`);
