/**
 * Syntax grammars for the languages opentui does not bundle (it ships
 * JavaScript, TypeScript, Markdown and Zig), found by NAME, never from a list
 * (owner, 2026-10-05: "use what the user has … dynamic and adaptable based on
 * only what the user has and uses"; "remember not to hardcode languages").
 *
 * The first time a reply or a diff shows a language:
 *   1. A grammar already on this machine is used: opentui's shared folder
 *      (~/.local/share/opentui/tree-sitter, or $XDG_DATA_HOME), which every
 *      opentui app fills — what opencode fetched is reused, and vice versa.
 *   2. Otherwise the language's own tree-sitter project is looked up by the
 *      naming convention every grammar follows (tree-sitter/tree-sitter-<name>,
 *      then tree-sitter-grammars/tree-sitter-<name>): its released .wasm and its
 *      queries/highlights.scm. opentui downloads them into the shared folder.
 *   3. Nothing found, or offline: the code shows as plain text, and a diff in
 *      the plain red/green of `git diff`.
 * Only the languages this user actually reads ever land on disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTreeSitterClient } from "@opentui/core";
import { useEffect, useState } from "react";

/** What opentui bundles; these need nothing. */
const BUNDLED = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact", "markdown", "markdown_inline", "zig"]);

/** Where the grammar projects live, in the order tried. Organisations, not languages. */
const ORGS = ["tree-sitter", "tree-sitter-grammars"];

/** opentui's shared grammar folder (its own rule: $XDG_DATA_HOME or ~/.local/share, then opentui/tree-sitter). */
export function sharedGrammarDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opentui", "tree-sitter");
}

export interface GrammarSource {
  filetype: string;
  wasm: string;
  highlights: string[];
}

/** A grammar already on disk for `filetype`, in the layout opentui caches to. */
export function localGrammar(filetype: string, dir = sharedGrammarDir()): GrammarSource | null {
  const wasm = path.join(dir, "languages", `tree-sitter-${filetype}.wasm`);
  if (!fs.existsSync(wasm)) return null;
  let queries: string[] = [];
  try {
    queries = fs
      .readdirSync(path.join(dir, "queries"))
      .filter((f) => f.startsWith(`${filetype}-`) && f.endsWith(".scm"))
      .map((f) => path.join(dir, "queries", f));
  } catch {
    /* no queries folder */
  }
  return queries.length ? { filetype, wasm, highlights: queries } : null;
}

/** The language's own project, found by name. */
export async function remoteGrammar(filetype: string, fetchFn: typeof fetch = fetch): Promise<GrammarSource | null> {
  if (!/^[a-z][a-z0-9_-]*$/.test(filetype)) return null;
  for (const org of ORGS) {
    const repo = `${org}/tree-sitter-${filetype}`;
    const wasm = `https://github.com/${repo}/releases/latest/download/tree-sitter-${filetype}.wasm`;
    try {
      const res = await fetchFn(wasm, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5_000) });
      if (res.ok) return { filetype, wasm, highlights: [`https://raw.githubusercontent.com/${repo}/HEAD/queries/highlights.scm`] };
    } catch {
      return null; // offline: stay plain, try again next run
    }
  }
  return null;
}

const resolved = new Map<string, Promise<boolean>>();

/**
 * Make `filetype` highlightable. Resolves true once its grammar is registered
 * (the caller then draws with it), false when there is none — asked once per
 * language per run.
 */
export function ensureGrammar(filetype: string | undefined): Promise<boolean> {
  if (!filetype) return Promise.resolve(false);
  if (BUNDLED.has(filetype)) return Promise.resolve(true);
  let p = resolved.get(filetype);
  if (!p) {
    p = (async () => {
      const src = localGrammar(filetype) ?? (await remoteGrammar(filetype));
      if (!src) return false;
      getTreeSitterClient().addFiletypeParser({ filetype, wasm: src.wasm, queries: { highlights: src.highlights } });
      return true;
    })().catch(() => false);
    resolved.set(filetype, p);
  }
  return p;
}

/** Synchronous view for render: true when the grammar is bundled or already registered. */
export function grammarReady(filetype: string | undefined): boolean | undefined {
  if (!filetype) return false;
  if (BUNDLED.has(filetype)) return true;
  return readyNow.get(filetype);
}
const readyNow = new Map<string, boolean>();

/** React hook: the filetype to draw with, once its grammar is ready (undefined = plain until then). */
export function useGrammar(filetype: string | undefined): string | undefined {
  const [ready, setReady] = useState<boolean | undefined>(() => grammarReady(filetype));
  useEffect(() => {
    if (ready !== undefined || !filetype) return;
    let live = true;
    void ensureGrammar(filetype).then((ok) => {
      readyNow.set(filetype, ok);
      if (live) setReady(ok);
    });
    return () => {
      live = false;
    };
  }, [filetype, ready]);
  return ready ? filetype : undefined;
}
