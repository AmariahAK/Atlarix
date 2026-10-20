/**
 * A command segment's words as the program it runs reads them, for the gates
 * (dangerous-commands.ts, mutating-commands.ts). Their patterns read words in a
 * fixed order from the start of a segment, so anything in front of the program
 * hid it: `git -c x=y reset --hard` discarded work without a card (E5), and
 * `git -C . commit` or `CI=1 git commit` ran in a read-only mode as if it were a
 * read. Enough of a shell to see the program and its arguments; not a shell.
 */

/** Shell words, quotes removed. */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let cur = "";
  let last = -1;
  for (let m = re.exec(segment); m; m = re.exec(segment)) {
    const part = m[1] ?? m[2] ?? m[3] ?? "";
    // Adjacent pieces (`-c"a b"`) are one word.
    if (m.index === last) cur += part;
    else {
      if (last !== -1) words.push(cur);
      cur = part;
    }
    last = m.index + m[0].length;
  }
  if (last !== -1) words.push(cur);
  return words;
}

/** git's own options before the subcommand that take the NEXT word as their value. */
const GIT_GLOBAL_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
  "--attr-source",
  "--list-cmds",
]);
/** Words that run the command after them as it is. */
const COMMAND_PREFIXES = new Set(["command", "env", "nohup", "time", "nice"]);

/**
 * The segment from its program on: `VAR=x` assignments and plain wrappers
 * skipped, and for git the binary's path dropped and git's own options (with
 * their values) skipped, so it reads `git <subcommand> <args…>`.
 */
export function programWords(segment: string): string[] {
  const words = shellWords(segment.replace(/^[\s(]+|[\s)]+$/g, ""));
  let i = 0;
  while (
    i < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || COMMAND_PREFIXES.has(words[i]!))
  )
    i++;
  if (!/(^|[\\/])git(\.exe)?$/i.test(words[i] ?? "")) return words.slice(i);
  i++;
  while (i < words.length && words[i]!.startsWith("-")) {
    i += GIT_GLOBAL_WITH_VALUE.has(words[i]!) ? 2 : 1;
  }
  return ["git", ...words.slice(i)];
}
