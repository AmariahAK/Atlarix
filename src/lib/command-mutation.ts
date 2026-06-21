/**
 * Compound-aware mutating/destructive command detection — the thin runtime
 * backstop for read-only work modes (Explore/Plan/Review).
 *
 * The PROMPT is the primary policy (the model is told to run only non-mutating
 * commands in read-only modes). This is the defense-in-depth gate so a mis-judged
 * or prompt-injected command can't slip through. It is a small DENY detector for
 * the clearly source/repo/system-mutating set — NOT a safe allowlist: reads,
 * dev servers, builds, tests, and dependency installs are deliberately NOT
 * flagged (they're allowed in read-only modes). Build/Debug bypass this gate
 * (the mode authorizes mutation); the always-on dangerous gate
 * (`dangerous-commands.ts`) and `.atlarix/permissions.json` rules are separate.
 *
 * Researched against Cursor/Antigravity/Codex/Claude Code/opencode: none rely on
 * a big hardcoded safe taxonomy — modes + rules + a small destructive backstop.
 */

const MUTATING_PATTERNS: RegExp[] = [
  // git: history / staging / remote / working-tree mutations.
  // (read-only git — status, log, diff, show, branch -l, remote -v — is NOT here)
  /^git\s+(add|commit|push|pull|fetch|merge|rebase|reset|revert|checkout|switch|restore|clean|rm|mv|cherry-pick|am|apply|stash\s+(drop|pop|clear)|branch\s+-[dD]|tag\s+-d|remote\s+(add|remove|rm|set-url))\b/,
  // filesystem: destructive / write / permission changes.
  /^(rm|rmdir|unlink|mv|cp|chmod|chown|chgrp|ln|truncate|shred|dd|tee)\b/,
  // process / system.
  /^(kill|pkill|killall|sudo|doas|shutdown|reboot|halt|systemctl|launchctl|mkfs|fdisk|mount|umount)\b/,
  // package publish / global / registry mutations — installs are NOT here.
  /^(npm|pnpm|yarn)\s+(publish|unpublish|deprecate|link|version|adduser|login|logout|token)\b/,
  // deploy / infra.
  /^(vercel|netlify|wrangler|fly|flyctl|kubectl)\b/,
  /^gh\s+(release|pr\s+merge|repo\s+(create|delete))\b/,
  /^docker\s+(push|run|rm|rmi|build|compose\s+(up|down))\b/,
  /^terraform\s+(apply|destroy)\b/,
  /^(pulumi\s+(up|destroy)|cdk\s+(deploy|destroy))\b/,
];

/**
 * Split a shell line into the commands it actually runs (compound-aware), so a
 * mutating segment inside `cd x && git push` can't hide behind a benign prefix.
 */
function commandSegments(command: string): string[] {
  return command
    // surface command substitutions so an inner mutating cmd is seen
    .replace(/\$\(([^)]*)\)/g, " ; $1 ; ")
    .replace(/`([^`]*)`/g, " ; $1 ; ")
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    // strip benign leading wrappers (cd DIR, env VAR=…, time, nice) — NOT sudo
    .map((s) =>
      s
        .replace(
          /^(?:cd\s+[^\s;&]+\s*|env\s+\w+=\S+\s+|time\s+|nice\s+(?:-n\s+-?\d+\s+)?)+/i,
          "",
        )
        .trim(),
    )
    .filter(Boolean);
}

/**
 * True if ANY segment is a clearly mutating/destructive command. Reads, dev
 * servers, builds, tests, and installs return false.
 */
export function isMutatingCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  for (const seg of commandSegments(trimmed)) {
    const lower = seg.toLowerCase();
    if (MUTATING_PATTERNS.some((p) => p.test(lower))) return true;
  }
  return false;
}
