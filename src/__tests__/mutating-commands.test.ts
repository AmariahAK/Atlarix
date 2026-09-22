import { describe, expect, it } from "vitest";
import {
  getMutationMatchIds,
  getMutationExplanation,
  isMutatingCommand,
  isMutatingSegment,
  mutationLabelKey,
} from "@/lib/mutating-commands";

/**
 * The must-auto-run corpus is the most important thing in this file.
 *
 * This detector is a DENY-list, so everything it fails to match runs without
 * asking. The failure mode that matters is not "it missed a mutation" — that is
 * the accepted, documented cost — it is "it caught a build", because then
 * Explore/Plan/Review stop being able to run the project and we have traded one
 * broken promise for another.
 *
 * Every entry below is a command an agent genuinely issues while investigating,
 * and several are commands that FAILED under the old read-only sandbox, which is
 * the whole reason this layer exists.
 */
const MUST_AUTO_RUN = [
  // reads
  "ls -la",
  "cat package.json",
  "head -n 40 src/index.ts",
  "rg --files-with-matches useAuth src",
  "find . -name '*.ts' -not -path './node_modules/*'",
  "wc -l src/lib/*.ts",
  // git history — every one of these is read-only
  "git status --short",
  "git log --oneline -20",
  "git diff HEAD~1",
  "git show 3b950bf2",
  "git branch -l",
  "git remote -v",
  "git config --get user.email",
  "git config --list",
  // git fetch and branch navigation: both FAILED under the old profile
  "git fetch",
  "git fetch --all --prune",
  "git checkout main",
  "git switch feature/x",
  // installs — product-writes, unnameable up front
  "npm install",
  "npm ci",
  "pnpm install --frozen-lockfile",
  "yarn",
  "pip install -r requirements.txt",
  "cargo fetch",
  "bundle install",
  "go mod download",
  // builds and checks
  "npm run build",
  "npx tsc --noEmit",
  "npx biome check src",
  "cargo build --release",
  "make",
  "./gradlew assembleDebug",
  // tests — vitest failed at STARTUP under the old profile
  "npx vitest run src/__tests__/foo.test.ts",
  "npm test",
  "pytest -q",
  "cargo test",
  // dev servers and containers
  "npm run dev",
  "docker build -t app .",
  "docker compose up -d",
  // network reads
  "curl -s https://example.com/api",
  // compound shapes an agent actually writes
  "cd packages/core && npm run build",
  'echo "HEAD: $(git log --oneline -1)"',
  "git log --oneline -5 | head -3",
  "cat src/a.ts | grep import",
  // quoted redirect characters are NOT redirects
  'echo "a > b"',
  "grep '>' src/a.ts",
  // redirects to sinks and temp are not source mutation
  "npm run build > /dev/null 2>&1",
  "npx tsc --noEmit > /tmp/tsc.log",
];

/**
 * The other half of the discrimination. Each of these names its target
 * syntactically — that is what separates a subject-write from a product-write.
 */
const MUST_ASK: Array<[string, string]> = [
  ["echo x > src/a.ts", "redirect"],
  ["echo x >> src/a.ts", "redirect"],
  ["cat template.txt > README.md", "redirect"],
  ["sed -i '' 's/a/b/' src/a.ts", "in-place-edit"],
  ["sed --in-place s/a/b/ src/a.ts", "in-place-edit"],
  ["perl -pi -e 's/a/b/' src/a.ts", "in-place-edit"],
  ["rm src/a.ts", "fs-write"],
  ["mv src/a.ts src/b.ts", "fs-write"],
  ["cp foo.ts src/a.ts", "fs-write"],
  ["tee src/a.ts", "fs-write"],
  ["chmod +x scripts/run.sh", "fs-write"],
  ["git add -A", "git-write"],
  ["git commit -m 'wip'", "git-write"],
  ["git reset --soft HEAD~1", "git-write"],
  ["git stash drop", "git-write"],
  ["git checkout -- src/a.ts", "git-discard"],
  ["git checkout .", "git-discard-all"],
  ["git config user.name bob", "git-config-write"],
  ["patch -p1 < fix.diff", "patch-apply"],
  ["npm pkg set version=9.9.9", "package-manifest-write"],
  ["npm publish", "registry-write"],
  ["vercel deploy", "deploy"],
  ["gh release create v1", "forge-write"],
  ["docker push app:latest", "docker-write"],
  ["terraform apply -auto-approve", "iac-apply"],
];

describe("must auto-run — the deny-list invariant", () => {
  it.each(MUST_AUTO_RUN)("%s", (command) => {
    expect(isMutatingCommand(command)).toBe(false);
  });

  it("installs and builds are not flagged even though they write the workspace", () => {
    // The stated discrimination: the write is the command's PRODUCT, not its
    // SUBJECT. Both of these write inside the workspace.
    expect(isMutatingCommand("npm install")).toBe(false);
    expect(isMutatingCommand("echo x > src/a.ts")).toBe(true);
  });
});

describe("must ask — subject-writes name their target", () => {
  it.each(MUST_ASK)("%s → %s", (command, expectedId) => {
    expect(isMutatingCommand(command)).toBe(true);
    expect(getMutationMatchIds(command.trim())).toContain(expectedId);
  });
});

describe("compound commands cannot hide a mutation behind a benign prefix", () => {
  it("finds a mutating segment after a benign one", () => {
    expect(isMutatingCommand("ls && rm src/a.ts")).toBe(true);
    expect(isMutatingCommand("npm run build; git commit -m x")).toBe(true);
    expect(isMutatingCommand("cd packages/core && sed -i '' s/a/b/ a.ts")).toBe(
      true,
    );
  });

  it("finds one inside a command substitution", () => {
    expect(isMutatingCommand('echo "$(rm -f src/a.ts)"')).toBe(true);
  });

  it("a benign compound stays benign", () => {
    expect(isMutatingCommand("cd packages/core && npm run build")).toBe(false);
  });
});

describe("the redirect rule reads the blanked skeleton, not the raw text", () => {
  it("a quoted '>' is not a redirect", () => {
    // `quoteAwareSegments` slices from the ORIGINAL string, so the segment still
    // carries its quotes. Without blanking, every one of these false-positives.
    expect(isMutatingSegment('echo "a > b"')).toBe(false);
    expect(isMutatingSegment("echo 'x >> y'")).toBe(false);
    expect(isMutatingSegment('git commit -m "fix: a > b"')).toBe(true); // git-write, not redirect
    expect(getMutationMatchIds('git commit -m "fix: a > b"')).not.toContain(
      "redirect",
    );
  });

  it("fd duplication is not a file redirect", () => {
    expect(isMutatingSegment("npm run build 2>&1")).toBe(false);
    expect(isMutatingSegment("make >&2")).toBe(false);
  });

  it("sinks and temp targets are exempt, real paths are not", () => {
    expect(isMutatingSegment("npm test > /dev/null")).toBe(false);
    expect(isMutatingSegment("npm test > /tmp/out.log")).toBe(false);
    expect(isMutatingSegment("npm test > out.log")).toBe(true);
  });

  it("an unparseable fragment is NOT flagged here — the gate already prompted", () => {
    // `resolveRunCommandPermissionGate` prompts for any line it cannot parse, so
    // a second fail-safe at segment level only double-counts — and it regresses a
    // fixed bug: `commandSegments` splices separators to surface `$(…)`, which
    // cuts a double-quoted span in half and hands this function a fragment
    // carrying one quote. Treating that as a redirect is what produced 24
    // indefinite approval blocks in a single session.
    expect(isMutatingSegment('echo "unterminated')).toBe(false);
    expect(isMutatingCommand('echo "HEAD: $(git log --oneline -1)"')).toBe(
      false,
    );
    // …and the substitution is still inspected: a mutation inside it is caught.
    expect(isMutatingCommand('echo "HEAD: $(rm -f src/a.ts)"')).toBe(true);
  });
});

describe("protected paths key separately from the generic redirect", () => {
  it.each([
    "echo hook > .git/hooks/pre-commit",
    "cp evil .git/hooks/pre-push",
    "chmod +x .atlarix/hooks/run.sh",
    "echo {} > .atlarix/permissions.json",
  ])("%s is protected-path", (command) => {
    expect(getMutationMatchIds(command)).toContain("protected-path");
  });

  it("allowing redirects must NOT thereby allow rewriting git hooks", () => {
    // The whole point of a separate id: the always-allow key differs, so a rule
    // saved for one can never satisfy the other.
    expect(mutationLabelKey("echo x > notes.txt")).toBe("mutate:redirect");
    expect(mutationLabelKey("echo x > .git/hooks/pre-commit")).toBe(
      "mutate:protected-path",
    );
  });

  it("READING a protected path is not a mutation", () => {
    expect(isMutatingSegment("cat .git/config")).toBe(false);
    expect(isMutatingSegment("ls .atlarix/skills")).toBe(false);
    expect(isMutatingSegment("grep -r hooks .atlarix")).toBe(false);
  });
});

describe("keys and prose", () => {
  it("is null for a non-mutating command", () => {
    expect(mutationLabelKey("ls -la")).toBeNull();
    expect(mutationLabelKey("")).toBeNull();
  });

  it("prefixes with mutate: so a coarse category rule can never satisfy it", () => {
    // Mirrors the invariant dangerLabelKey upholds: "always allow git" is stored
    // under the category key `git`, which shares no namespace with these.
    const key = mutationLabelKey("git commit -m x")!;
    expect(key.startsWith("mutate:")).toBe(true);
    expect(key).not.toBe("git");
  });

  it("is deterministic when several patterns match", () => {
    const a = mutationLabelKey("git add . > out.log");
    const b = mutationLabelKey("git add . > out.log");
    expect(a).toBe(b);
    expect(a).toBe("mutate:git-write+redirect");
  });

  it("explains the protected path ahead of the generic reason", () => {
    expect(getMutationExplanation("echo x > .git/hooks/pre-commit")).toMatch(
      /git hooks|\.atlarix/,
    );
    expect(getMutationExplanation("rm src/a.ts")).toMatch(/deletes|writes/i);
  });
});
