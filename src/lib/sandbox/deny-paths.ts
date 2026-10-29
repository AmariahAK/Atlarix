import fs from "node:fs";
import path from "node:path";
import { atlarixHomeDir } from "@/paths/atlarix-home";
import { userAgentSkillsParentDir } from "@/lib/plugins/paths";

/**
 * The paths a source-protected run must not write, even though the workspace
 * around them is writable.
 *
 * WHY A DENY-LIST AND NOT AN ALLOW-LIST. Read-only modes used to work by
 * dropping the workspace from the writable set entirely. Measured, that also
 * broke every Vite-based project at STARTUP (vitest writes
 * `node_modules/.vite-temp` before it reads its own config), plus `npm install`,
 * every build, every dev server, and `git fetch` — all of which the mode prompts
 * promised worked. The obvious repair is to allow-list the build caches, but
 * that means enumerating `node_modules/.vite`, `.next`, `target`, `.gradle`, …
 * per language, forever, and being wrong about the next toolchain.
 *
 * Nobody does that. Surveyed, every reference harness makes the workspace
 * writable and denies a short, stable, language-independent set instead:
 * Cursor protects `.git/config`, `.git/hooks` and `.vscode`; Codex's
 * `workspace-write` protects `.git/`, `.codex/` and `.agents`; Claude Code
 * leaves the project dir writable and enforces plan-mode read-only with a
 * command classifier. The list below is that shape for Atlarix.
 *
 * WHAT MAKES THESE THREE DIFFERENT from the rest of a project: they are not
 * source, they are EXECUTION AND IDENTITY. `.git/hooks` runs on the next commit.
 * `.git/config` can point a fetch at another host or set a proxy. `.atlarix/`
 * holds `permissions.json`, `hooks/`, `agents/` and `skills/` — the rules that
 * decide what the agent is allowed to do next. A command that edits one of them
 * is not making a change you can read in a diff; it is changing what happens
 * afterwards. That is a stable property of what those files ARE, which is why
 * this list does not rot the way a cache list would.
 *
 * Cursor's carve is followed rather than Codex's whole-`.git`: `git fetch` and
 * `git checkout` write elsewhere under `.git/`, and both are things the prompts
 * promise and the old profile broke. Protecting the whole directory would trade
 * one wrong answer for another.
 *
 * COVERAGE IS UNEVEN, AND NOTHING MAY CLAIM OTHERWISE. macOS Seatbelt and the
 * Linux `bwrap` fallback enforce this in the kernel. The bundled Linux Landlock
 * helper and the Windows Low-IL helper cannot: Landlock grants beneath a root
 * and has no deny primitive, and a Low mandatory label inherits downward, so
 * carving a hole means up-labelling paths inside the user's real `.git` and
 * leaving that behind. On those two the command gate (`mutating-commands.ts`,
 * id `protected-path`) is the only layer — which is why the gate carries the
 * same rule, and why no prompt says "blocked".
 */
const PROTECTED_RELATIVE = [
  path.join(".git", "config"),
  path.join(".git", "hooks"),
  ".atlarix",
] as const;

/**
 * Absolute paths to deny writes to for a source-protected run.
 *
 * MISSING ENTRIES ARE KEPT, NOT PRUNED — the exact inverse of the rule for
 * writable paths, where a non-existent path is dropped because binding it would
 * fail. A deny on a path that does not exist yet is the entire point: it is what
 * stops `.atlarix/` being CREATED by a command in a project that does not have
 * one. Pruning them would make the protection depend on whether the user
 * happened to have the directory already.
 */
export function readOnlyDenyPaths(workspacePath: string): string[] {
  if (!workspacePath) return [];
  const root = path.resolve(workspacePath);
  return PROTECTED_RELATIVE.map((rel) => path.join(root, rel));
}

/**
 * Denied on every sandboxed run, whatever the mode or a granted folder says: the
 * WHOLE `<atlarixHomeDir>`. The plugins, the install record and `hooks.json` live
 * there and decide what runs next; denying only those three left the folder
 * itself renameable (`mv ~/.atlarix x`, write `x/hooks.json`, move it back) and,
 * under bwrap, a missing `hooks.json` creatable. No sandboxed command has a reason
 * to write there — the agent's memory is written by the file tools, not commands —
 * and it only matters at all when the workspace or a grant contains it.
 */
export function pluginControlDenyPaths(): string[] {
  const out: string[] = [];
  // And `~/.agents/skills`: the person's installed skills (plugins/paths.ts).
  for (const p of [
    atlarixHomeDir(),
    path.join(userAgentSkillsParentDir(), "skills"),
  ]) {
    out.push(p);
    // Seatbelt matches the path a write RESOLVES to: when `~/.atlarix` is a link,
    // deny its real location as well.
    try {
      const real = fs.realpathSync(p);
      if (real !== p) out.push(real);
    } catch {
      // not created yet: the configured path is what a write would create
    }
  }
  return out;
}
