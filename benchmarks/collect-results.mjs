#!/usr/bin/env node
/**
 * Collect Harbor Terminal-Bench results into a readable harness × model table.
 *
 * run-matrix.sh writes each run to results/<model>/<harness>/<timestamp>/result.json,
 * so model + harness come from the PATH; pass/total come from the JSON.
 * Harbor 0.13 result shape (confirmed):
 *   stats.evals[<agent>__<dataset>].reward_stats.reward["1.0"|"0.0"] = [taskId,...]
 *   stats.evals[...].n_errors
 *
 * Usage: node benchmarks/collect-results.mjs [results-root=./results]
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? "results";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "result.json") out.push(p);
  }
  return out;
}

function reward(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const ev = Object.values(data?.stats?.evals ?? {})[0];
  if (!ev) return null;
  const r = ev.reward_stats?.reward ?? {};
  const passed = (r["1.0"] ?? []).length;
  const failed = (r["0.0"] ?? []).length;
  const total = passed + failed;
  return total ? { passed, total, errors: ev.n_errors ?? 0 } : null;
}

if (!fs.existsSync(root)) {
  console.error(`results root not found: ${root}`);
  process.exit(1);
}

// rel path: <model>/<harness>/<run>/result.json  → model, harness from path.
const rows = [];
for (const file of walk(root)) {
  const rel = path.relative(root, file).split(path.sep);
  if (rel.length < 3) continue; // need model/harness/.../result.json
  const r = reward(file);
  if (!r) continue;
  rows.push({
    model: rel[0],
    harness: rel[1],
    ...r,
    accuracy: (r.passed / r.total) * 100,
  });
}
if (!rows.length) {
  console.error(
    `No parseable result.json under ${root} (expected results/<model>/<harness>/.../result.json)`,
  );
  process.exit(1);
}

// Keep the latest row per (model, harness) if a cell was run more than once.
const latest = new Map();
for (const r of rows) latest.set(`${r.model}::${r.harness}`, r);
const data = [...latest.values()];

const harnesses = [...new Set(data.map((r) => r.harness))].sort();
const models = [...new Set(data.map((r) => r.model))].sort();
const cell = (h, m) => data.find((r) => r.harness === h && r.model === m);

let md = "# Terminal-Bench 2.0 — harness × model (% resolved)\n\n";
md += `| Harness | ${models.join(" | ")} |\n|${"---|".repeat(models.length + 1)}\n`;
for (const h of harnesses) {
  md += `| **${h}** | ${models
    .map((m) => {
      const c = cell(h, m);
      return c ? `${c.accuracy.toFixed(1)}% (${c.passed}/${c.total})` : "—";
    })
    .join(" | ")} |\n`;
}
md += `\n_Fixed model + pinned provider; the harness is what's under test._\n`;

let csv = "harness,model,passed,total,accuracy_pct,errors\n";
for (const r of data) {
  csv += `${r.harness},${r.model},${r.passed},${r.total},${r.accuracy.toFixed(2)},${r.errors}\n`;
}

fs.writeFileSync(path.join(root, "summary.md"), md);
fs.writeFileSync(path.join(root, "summary.csv"), csv);
console.log(md);
console.log(`Wrote ${path.join(root, "summary.md")} + summary.csv`);
