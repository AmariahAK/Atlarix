/**
 * Mutating-command detection for the read-only work modes.
 * ========================================================
 *
 * THE INVARIANT, AND THE WHOLE REASON THIS FILE IS SHAPED THIS WAY:
 * this is a DENY-LIST of write-shaped commands, never an allow-list of read
 * commands. Anything it does not match auto-runs. That is what lets
 * `npm install`, `cargo build`, `vitest`, `npm run dev`, `make`, `tsc` and
 * `git fetch` keep working in Explore/Plan/Review **without being enumerated
 * anywhere** — and it is the property the previous `command-default-allow.ts`
 * taxonomy lost, which is why that one was deleted.
 *
 * The distinction is NOT "does it write the workspace". Both `npm install` and
 * `echo x > src/a.ts` write the workspace. It is:
 *
 *   is the write the command's PRODUCT, or its SUBJECT?
 *
 * Product-writes — a build artifact, a dependency tree, a dep-optimiser cache —
 * cannot be named up front (every toolchain invents its own), so they are not
 * deny-listed and must never be. Subject-writes always name their target
 * syntactically: `-i`, a `>` redirect, a pathspec. That syntax is what the
 * patterns below match.
 *
 * WHY IT EXISTS AT ALL. Read-only modes used to be enforced by an OS sandbox
 * that dropped the workspace from the writable set. Measured, that also broke
 * every Vite-based project at STARTUP (vitest writes `node_modules/.vite-temp`
 * before it reads its own config), plus installs, builds, dev servers and
 * `git fetch` — all of which the mode prompts promised worked. The reference
 * harnesses (Codex `workspace-write`, Cursor Sandbox Mode, Claude Code plan
 * mode) all make the workspace writable and enforce "don't change the source"
 * one layer up, at command classification. This is that layer.
 *
 * It is DEFENCE IN DEPTH, not a guarantee, and nothing in the prompt may claim
 * otherwise. `python -c "open('src/a.ts','w')"` is not write-shaped in any way a
 * pattern can see. A miss means a command runs that should have asked — which is
 * the accepted cost of the trade, and the reason the mode prompts say "asks
 * first", never "cannot".
 *
 * Recovered from `src/lib/command-mutation.ts`, deleted in 3b950bf2
 * ("v14.10.0 — command permissions rebuilt"), and reworked in four ways:
 *  - restructured into the `{ id, pattern, explanation }` shape that
 *    `dangerous-commands.ts` and `system-scope-commands.ts` already use, so a
 *    card gets prose and "always allow" gets a FINE-GRAINED key;
 *  - the old list had NO in-place editor at all (`sed -i`, `perl -pi`) and no
 *    redirect rule — between them, the majority of real source mutation;
 *  - entries that are now legitimate capability came out (see DELTAS below);
 *  - it prompts instead of hard-blocking. The old consumer refused the command
 *    outright; a card lets the user say yes.
 */

import { commandSegments, unquotedSkeleton } from "./command-segments";
import { GIT_INLINE_ALIAS, programWords } from "./command-words";

export interface MutationMatch {
  /** Stable, kebab-case id — used as the always-allow permission key. */
  id: string;
  pattern: RegExp;
  explanation: string;
}

/**
 * DELTAS from the recovered list, each for its own reason:
 *
 *  - `fetch` dropped from the git alternation. `git fetch` writes `.git/objects`
 *    and remote refs; it never touches the working tree. It is also one of the
 *    things the mode prompts explicitly promise, and it FAILED under the old
 *    profile (`cannot lock ref … Operation not permitted`), so leaving it here
 *    would trade one wrong answer for another.
 *  - `build` dropped from the docker alternation, and `run` / `compose up` with
 *    it. A build is the capability being restored; starting a service is how you
 *    preview an app. A `-v` mount that reaches outside the workspace is already
 *    caught by `targetsOutsideWorkspace` in system-scope-commands.ts.
 *  - `kill|pkill|killall` dropped. Killing a dev server you started is ordinary
 *    Explore work, `background_jobs` owns the supervised path, and none of it is
 *    a source mutation. (They remain in DANGEROUS_FIRST_TOKENS, so `kill -9 1`
 *    still raises the danger card it always did.)
 *  - `sudo|doas|shutdown|…|mount` dropped as redundant: every one of them is
 *    already a danger pattern or a system-scope pattern, and duplicating them
 *    here would key the same command under two prefixes.
 *
 * KEPT deliberately: `pull`, `merge`, `rebase`, `reset`, `revert`, `restore`,
 * `stash pop|drop`. These rewrite the working tree — the same class as `sed -i`,
 * whatever their intent.
 */
export const MUTATING_PATTERNS: MutationMatch[] = [
  // ── git: history / staging / remote / working-tree mutation ──────────────
  // Read-only git (status, log, diff, show, branch -l, remote -v) is NOT here.
  {
    id: "git-write",
    pattern:
      /^git\s+(add|commit|push|pull|merge|rebase|reset|revert|restore|clean|rm|mv|cherry-pick|am|apply|stash\s+(drop|pop|clear)|branch\s+-[dD]|tag\s+-d|remote\s+(add|remove|rm|set-url))\b/,
    explanation:
      "This changes the repository — staged files, history, the working tree, or a remote.",
  },
  // An alias defined on the command line can be any subcommand (command-words.ts).
  {
    id: "git-inline-alias",
    pattern: GIT_INLINE_ALIAS,
    explanation: "This defines a git alias on the command line, so whether it changes the repository can't be checked.",
  },
  // `checkout` / `switch` are deliberately absent from the generic rule above:
  // branch navigation is read-safe and is exactly what someone planning a change
  // wants to do. Only the forms that DISCARD working-tree changes are flagged.
  {
    id: "git-discard",
    pattern: /^git\s+checkout\b.*\s--(\s|$)/,
    explanation:
      "This discards your uncommitted changes to those files. They cannot be recovered.",
  },
  {
    id: "git-discard-all",
    pattern: /^git\s+checkout\s+\.(\s|$)/,
    explanation:
      "This discards every uncommitted change in the working tree. They cannot be recovered.",
  },
  // `git config` is not in the generic git rule because the read forms are
  // common and harmless. Only the write forms are flagged.
  {
    id: "git-config-write",
    pattern: /^git\s+config\b(?!.*\s(--get\b|--get-all\b|--list\b|-l\b))/,
    explanation:
      "This rewrites git configuration, which can change how every later git command behaves.",
  },

  // ── filesystem: write / destroy / permission ─────────────────────────────
  {
    id: "fs-write",
    pattern:
      /^(rm|rmdir|unlink|mv|cp|chmod|chown|chgrp|ln|truncate|shred|dd|tee)\b/,
    explanation:
      "This writes, moves, deletes, or changes permissions on files directly.",
  },
  // THE BIGGEST HOLE IN THE RECOVERED LIST. An in-place editor is the purest
  // subject-write there is: the target is named on the command line and the
  // edit is the entire point. None of these appeared in the old patterns.
  {
    id: "in-place-edit",
    pattern:
      /^(sed\s+(-[a-z]*i|--in-place)|perl\s+-[a-z]*i|ruby\s+-[a-z]*i|gawk\s+-i\s+inplace|awk\s+-i\s+inplace)\b/,
    explanation:
      "This edits the named files in place, overwriting them where they sit.",
  },
  {
    id: "patch-apply",
    pattern: /^patch\b/,
    explanation: "This applies a diff to your source files.",
  },
  {
    id: "package-manifest-write",
    pattern: /^(npm|pnpm|yarn|bun)\s+pkg\s+set\b/,
    explanation: "This rewrites fields in package.json.",
  },

  // ── publish / registry / deploy / infra ──────────────────────────────────
  // Installs are NOT here, deliberately — see the invariant at the top.
  {
    id: "registry-write",
    pattern:
      /^(npm|pnpm|yarn)\s+(publish|unpublish|deprecate|link|version|adduser|login|logout|token)\b/,
    explanation:
      "This changes something in the package registry or your logged-in account, not just this project.",
  },
  {
    id: "deploy",
    pattern: /^(vercel|netlify|wrangler|fly|flyctl|kubectl)\b/,
    explanation: "This deploys or changes live infrastructure.",
  },
  {
    id: "forge-write",
    pattern: /^gh\s+(release|pr\s+merge|repo\s+(create|delete))\b/,
    explanation:
      "This changes something on the forge — a release, a merged PR, or a repository.",
  },
  {
    id: "docker-write",
    pattern: /^docker\s+(push|rm|rmi)\b/,
    explanation: "This pushes or removes container images.",
  },
  {
    id: "iac-apply",
    pattern:
      /^(terraform\s+(apply|destroy)|pulumi\s+(up|destroy)|cdk\s+(deploy|destroy))\b/,
    explanation: "This applies infrastructure changes to real resources.",
  },
];

/**
 * Paths that turn a repository into code execution, or that govern the agent
 * itself. The one carve-out every reference harness keeps — Cursor protects
 * `.git/config` + `.git/hooks`, Codex protects `.git/` + `.codex/`.
 *
 * This is the GATE half of that protection, and on Windows and on the bundled
 * Linux Landlock helper it is the ONLY half: neither mechanism has a deny
 * primitive (Low IL labels inherit downward; Landlock grants beneath a root).
 * macOS Seatbelt and the Linux bwrap fallback also deny these in the kernel.
 * Because the coverage is uneven, no prompt may claim these are "blocked".
 */
const PROTECTED_PATH_RE = /(^|[\s"'=/\\])\.(git[/\\](config|hooks)|atlarix)\b/;

/** Commands that write their argument rather than reading it. */
const WRITE_SHAPED_FIRST_TOKEN =
  /^(rm|rmdir|unlink|mv|cp|chmod|chown|chgrp|ln|truncate|shred|dd|tee|install|patch|sed|perl|ruby|gawk|awk|git)\b/;

/**
 * Redirect targets that are not a source mutation: the standard sinks, and
 * anything under a temp root.
 *
 * Literal prefixes rather than `os.tmpdir()` so this module stays importable
 * from either process. `/var/folders` is macOS's per-user temp root, which is
 * what `os.tmpdir()` actually returns there.
 */
const BENIGN_REDIRECT_TARGET =
  /^(\/dev\/(null|stdout|stderr|tty|fd\/\d+)|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\$TMPDIR\/|%TEMP%[/\\]|\$\{TMPDIR\})/i;

/**
 * Does this segment redirect into a real file?
 *
 * Scans the BLANKED skeleton, never the raw segment. `quoteAwareSegments`
 * slices its output from the ORIGINAL command string, so a segment still
 * carries its quoted characters — `echo "a > b"` would otherwise be read as a
 * redirect into `b`. `unquotedSkeleton` blanks quoted spans while preserving
 * length 1:1, which is exactly what makes this safe.
 *
 * AN UNPARSEABLE SEGMENT RETURNS FALSE, and that is deliberate rather than
 * lax. `resolveRunCommandPermissionGate` already prompts for any command whose
 * quoting it cannot parse, so the whole line has faced a human before this ever
 * runs — a second fail-safe here only double-counts.
 *
 * It also actively regresses a fixed bug. `commandSegments` surfaces `$(…)` by
 * splicing separators into the line, which splits a double-quoted span across
 * segments: `echo "HEAD: $(git log --oneline -1)"` yields a fragment `echo "HEAD:`
 * with one quote. Failing safe on that fragment reproduces exactly the shape that
 * produced 24 indefinite approval blocks in a half-hour session — the thing the
 * quoting fix in `command-segments.ts` exists to stop.
 */
function redirectsToFile(segment: string): boolean {
  const skeleton = unquotedSkeleton(segment);
  if (skeleton == null) return false; // the gate already prompted for this line
  // Drop fd duplications (`2>&1`, `>&2`) — they redirect to a descriptor, not a file.
  const withoutFdDups = skeleton.replace(/\d*>&\s*\d+/g, " ");
  const redirect = /(?:^|[^>])>>?\s*([^\s|;&<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirect.exec(withoutFdDups)) !== null) {
    const target = (m[1] ?? "").trim();
    if (!target) continue;
    if (BENIGN_REDIRECT_TARGET.test(target)) continue;
    return true;
  }
  return false;
}

/**
 * All mutation ids ONE segment matches, deduped and sorted for a deterministic
 * key. Empty when the segment is not a mutation.
 *
 * Segment-scoped on purpose: the caller (`classifySegment`) already works per
 * segment, and a per-segment verdict is what lets `cd x && sed -i …` be keyed
 * to the part that actually needs approval.
 *
 * The protected-path check runs FIRST so `echo x > .git/hooks/pre-commit` keys
 * as `protected-path` rather than the generic `redirect` — a user who allows
 * redirects has not thereby allowed rewriting their git hooks.
 */
export function getMutationMatchIds(segment: string): string[] {
  const trimmed = (segment || "").trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const ids = new Set<string>();

  if (
    PROTECTED_PATH_RE.test(lower) &&
    (WRITE_SHAPED_FIRST_TOKEN.test(lower) || redirectsToFile(trimmed))
  ) {
    ids.add("protected-path");
  }

  // Also as the program reads it: `git -C . commit` and `CI=1 git commit` put
  // something in front of the words these patterns anchor on.
  const program = programWords(trimmed).join(" ").toLowerCase();
  for (const { id, pattern } of MUTATING_PATTERNS) {
    if (pattern.test(lower) || pattern.test(program)) ids.add(id);
  }

  if (!ids.has("protected-path") && redirectsToFile(trimmed)) {
    ids.add("redirect");
  }

  return [...ids].sort();
}

/** True if this ONE segment is a source/repo mutation. */
export function isMutatingSegment(segment: string): boolean {
  return getMutationMatchIds(segment).length > 0;
}

/**
 * True if ANY segment of a whole command line mutates. Convenience for callers
 * that have not split the line themselves; the gate uses the per-segment form.
 */
export function isMutatingCommand(command: string): boolean {
  const trimmed = (command || "").trim();
  if (!trimmed) return false;
  return commandSegments(trimmed).some((seg) => isMutatingSegment(seg));
}

/**
 * The first segment of a command line that mutates, or null.
 *
 * The card must explain the part that actually stopped, not the line. For
 * `cd packages/core && sed -i '' s/a/b/ a.ts`, the useful sentence is about the
 * in-place edit — describing the whole line would have to describe `cd`.
 */
export function firstMutatingSegment(command: string): string | null {
  const trimmed = (command || "").trim();
  if (!trimmed) return null;
  return commandSegments(trimmed).find((seg) => isMutatingSegment(seg)) ?? null;
}

/**
 * The stable permission key for a mutating segment — `mutate:<id>[+<id>…]`.
 * Returns null when the segment does not mutate.
 *
 * The `mutate:` prefix guarantees no collision with first-token category keys
 * or `danger:` keys in the shared command-permission store — so an
 * "always allow git" (category) can never satisfy `mutate:git-write`, the same
 * invariant `dangerLabelKey` upholds.
 */
export function mutationLabelKey(segment: string): string | null {
  const ids = getMutationMatchIds(segment);
  return ids.length ? `mutate:${ids.join("+")}` : null;
}

/** Plain-English reason for the approval card. */
export function getMutationExplanation(segment: string): string {
  const ids = new Set(getMutationMatchIds(segment));
  if (ids.has("protected-path")) {
    return "This writes to git configuration, git hooks, or .atlarix/ — the files that decide what runs in this project.";
  }
  const lower = (segment || "").trim().toLowerCase();
  const match = MUTATING_PATTERNS.find(({ pattern }) => pattern.test(lower));
  if (match) return match.explanation;
  if (ids.has("redirect")) {
    return "This redirects output into a file, replacing or appending to whatever is there.";
  }
  return "This changes files in your project.";
}
