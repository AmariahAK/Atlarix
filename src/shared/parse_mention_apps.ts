/**
 * Parse `@`-mentions of files and folders in the current workspace.
 * Tokens are inserted by the composer autocomplete as `@file:<relpath>` and
 * `@dir:<relpath>` (paths contain no spaces). Replaces the old `@app:` mention
 * that injected another workspace's whole codebase.
 */

const FILE_MENTION_REGEX = /@file:([^\s]+)/g;
const DIR_MENTION_REGEX = /@dir:([^\s]+)/g;

export interface ContextMentions {
  files: string[];
  dirs: string[];
}

export function parseContextMentions(prompt: string): ContextMentions {
  const files = [...prompt.matchAll(FILE_MENTION_REGEX)].map((m) => m[1]);
  const dirs = [...prompt.matchAll(DIR_MENTION_REGEX)].map((m) => m[1]);
  return { files: [...new Set(files)], dirs: [...new Set(dirs)] };
}
