/**
 * The files `@` offers: `rg --files` from the workspace (so .gitignore is
 * honoured, like Codex's and opencode's pickers), plus the folders they are in.
 * Listed once and refreshed when older than a few seconds, so a file the agent
 * just wrote shows up.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const MAX_FILES = 50_000;
const FRESH_MS = 5_000;

let cache: { dir: string; at: number; entries: string[] } | null = null;

/** Workspace-relative paths, "/"-separated; folders end in "/". */
export async function listWorkspaceEntries(dir: string): Promise<string[]> {
  if (cache && cache.dir === dir && Date.now() - cache.at < FRESH_MS) return cache.entries;
  const { resolveRipgrepPath } = await import("@/lib/tools/resolve-ripgrep");
  const rg = await resolveRipgrepPath();
  const files = await new Promise<string[]>((resolve) => {
    const out: string[] = [];
    let buf = "";
    const child = spawn(rg, ["--files", "--hidden", "--glob", "!.git/", "--sort", "path"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l) out.push(l);
      if (out.length >= MAX_FILES) child.kill();
    });
    child.on("error", () => resolve(out));
    child.on("close", () => {
      if (buf) out.push(buf);
      resolve(out.slice(0, MAX_FILES));
    });
  });
  const norm = files.map((f) => f.split(path.sep).join("/").replace(/^\.\//, ""));
  const folders = new Set<string>();
  for (const f of norm) {
    let i = f.indexOf("/");
    while (i > 0) {
      folders.add(f.slice(0, i + 1));
      i = f.indexOf("/", i + 1);
    }
  }
  const entries = [...[...folders].sort(), ...norm];
  cache = { dir, at: Date.now(), entries };
  return entries;
}

/**
 * Best matches for what follows `@`: a file NAME starting with the query first,
 * then a name containing it, then a path containing it, then the letters in
 * order (fuzzy). Shorter paths win ties. Empty query: top-level entries.
 */
export function filterEntries(entries: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  if (!q) return entries.filter((e) => !e.replace(/\/$/, "").includes("/")).slice(0, limit);
  const scored: Array<{ e: string; score: number }> = [];
  for (const e of entries) {
    const lower = e.toLowerCase();
    const name = lower.replace(/\/$/, "").split("/").pop()!;
    let score: number;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (subsequence(lower, q)) score = 3;
    else continue;
    scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score || a.e.length - b.e.length || a.e.localeCompare(b.e));
  return scored.slice(0, limit).map((s) => s.e);
}

function subsequence(hay: string, needle: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

/** The `@query` being typed at the end of `beforeCursor`, or null. */
export function mentionAt(beforeCursor: string): string | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
  return m ? m[1]! : null;
}

/** What replaces `@query`: the path, quoted if it has spaces, then a space. */
export function mentionInsert(entry: string): string {
  return /\s/.test(entry) ? `"${entry}" ` : `${entry} `;
}
