/** Does a language grammar resolve by name and highlight? `bun scripts/probes/grammar-probe.ts` (needs network the first time). */
import { getTreeSitterClient } from "@opentui/core";
import { ensureGrammar } from "../../src/cli/tui/grammars";
const samples: Record<string, string> = {
  python: "def add(a, b):\n    return a + 1  # hi\n",
  rust: "fn main() { let x: u32 = 5; println!(\"{}\", x); }\n",
  go: "package main\nfunc main() { x := 1 }\n",
  yaml: "name: atlarix\nversion: 1\n",
  json: '{"a": 1, "b": true}\n',
  toml: 'name = "x"\n[deps]\n',
  bash: 'echo "hi" && ls -la\n',
  nosuchlang: "x",
};
const client = getTreeSitterClient();
await client.initialize();
for (const [ft, code] of Object.entries(samples)) {
  const t0 = Date.now();
  const ok = await ensureGrammar(ft);
  let groups = "";
  if (ok) {
    const r = await client.highlightOnce(code, ft);
    groups = [...new Set((r.highlights ?? []).map((h: any) => h[2]))].slice(0, 8).join(",");
    if ((r as any).error) groups = "ERROR " + (r as any).error;
  }
  console.log(ft.padEnd(11), ok ? "registered" : "plain", `${Date.now() - t0}ms`, groups);
}
process.exit(0);
