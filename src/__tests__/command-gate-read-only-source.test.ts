import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The mutation verdict, asserted THROUGH THE GATE.
 *
 * `mutating-commands.test.ts` proves the matcher. This file proves the thing
 * that actually ships: that a read-only caller gets an approval card for a
 * source edit, that everything else still auto-runs, and that Build and Debug
 * are untouched.
 *
 * The distinction being pinned is not "does it write the workspace" — `npm
 * install` and `echo x > src/a.ts` both do. It is whether the write is the
 * command's PRODUCT or its SUBJECT. Get that wrong in the strict direction and
 * Explore can no longer build or test the project, which is the exact failure
 * this whole change exists to fix.
 */

const decisions = new Map<string, "always_allow" | "always_deny">();
vi.mock("@/lib/command-permissions-store", () => ({
  getWorkspaceCommandPermission: (appId: number, category: string) =>
    decisions.get(`${appId}:${category.trim().toLowerCase()}`) ?? null,
  listWorkspaceCommandPermissions: () => [],
  upsertWorkspaceCommandPermission: () => {},
  revokeWorkspaceCommandPermission: () => false,
}));

import {
  resolveRunCommandPermissionGate,
  runCommandCategoryPreflight,
} from "@/ipc/handlers/command_permission_handlers";

const APP = 1;
const WS = "/work/project";

/** A read-only-source caller: Explore, Plan, Review, or any sub-agent. */
const readOnly = (cmd: string) =>
  resolveRunCommandPermissionGate(cmd, APP, WS, true);
/** Build / Debug. */
const writeMode = (cmd: string) =>
  resolveRunCommandPermissionGate(cmd, APP, WS, false);

afterEach(() => decisions.clear());

describe("read-only source: the project still runs", () => {
  it.each([
    "ls -la",
    "cat package.json",
    "git status --short",
    "git log --oneline -20",
    "git diff HEAD~1",
    "git fetch --all --prune",
    "git checkout main",
    "npm install",
    "npm ci",
    "npm run build",
    "npm test",
    "npx vitest run src/a.test.ts",
    "npx tsc --noEmit",
    "npx biome check src",
    "cargo build --release",
    "make",
    "npm run dev",
    "docker build -t app .",
    "cd packages/core && npm run build",
  ])("%s auto-runs", (cmd) => {
    expect(readOnly(cmd).action).toBe("auto_allow");
  });

  it("the four commands that FAILED under the old read-only sandbox now auto-run", () => {
    // Measured against this repo before the change: vitest died at startup on
    // `node_modules/.vite-temp`, npm install on `node_modules`, a build on
    // `dist/`, and git fetch on `.git/refs/…/HEAD.lock`.
    for (const cmd of [
      "npx vitest run src/a.test.ts",
      "npm install",
      "npm run build",
      "git fetch",
    ]) {
      expect(readOnly(cmd).action).toBe("auto_allow");
    }
  });
});

describe("read-only source: a source edit asks first", () => {
  it.each([
    "echo x > src/a.ts",
    "sed -i '' 's/a/b/' src/a.ts",
    "perl -pi -e 's/a/b/' src/a.ts",
    "mv src/a.ts src/b.ts",
    "tee src/a.ts",
    "git commit -m wip",
    "git add -A",
    "git checkout -- src/a.ts",
    "git config user.name bob",
  ])("%s prompts", (cmd) => {
    const gate = readOnly(cmd);
    expect(gate.action).toBe("prompt");
    expect(gate).toMatchObject({ reason: "mutation" });
  });

  it("names the reason so the card can explain itself", () => {
    expect(readOnly("sed -i '' s/a/b/ src/a.ts")).toMatchObject({
      action: "prompt",
      reason: "mutation",
      category: "mutate:in-place-edit",
      dangerous: false,
    });
  });

  it("a mutation is not mislabelled as dangerous", () => {
    // The amber danger badge means something specific. A `git commit` is a
    // mutation, not a destructive/outward action, and conflating them would
    // both cry wolf and make the danger badge meaningless.
    expect(readOnly("git commit -m wip")).toMatchObject({ dangerous: false });
  });

  it("danger still wins over mutation, keeping its fine-grained key", () => {
    // `rm -rf` is BOTH. It must stay keyed on danger so the amber badge shows
    // and so an "always allow" saved for it is the danger rule, not a blanket
    // mutation allowance.
    const gate = readOnly("rm -rf build");
    expect(gate).toMatchObject({ action: "prompt", dangerous: true });
    expect(
      gate.action === "prompt" && gate.category.startsWith("danger:"),
    ).toBe(true);
  });

  it("commands that were ALREADY dangerous keep their reason, not a new one", () => {
    // `rm`, `chmod`, `chown`, `dd` and friends are DANGEROUS_FIRST_TOKENS, so
    // they have always prompted in every mode. They are not new mutation cards,
    // and mislabelling them would lose the amber badge and the danger rule key.
    for (const cmd of ["rm src/a.ts", "chmod +x run.sh", "chown me src"]) {
      expect(readOnly(cmd)).toMatchObject({
        action: "prompt",
        dangerous: true,
        reason: "danger",
      });
      // …and they prompted in Build too, before any of this.
      expect(writeMode(cmd).action).toBe("prompt");
    }
  });

  it("a mutation hidden behind a benign prefix is still found", () => {
    expect(readOnly("ls && tee src/a.ts").action).toBe("prompt");
    expect(readOnly("npm run build; git commit -m x").action).toBe("prompt");
  });
});

describe("Build and Debug are unchanged — by construction, not by exception", () => {
  it.each([
    "echo x > src/a.ts",
    "sed -i '' 's/a/b/' src/a.ts",
    "git commit -m wip",
    "git add -A",
    "mv src/a.ts src/b.ts",
    "tee src/a.ts",
  ])("%s auto-runs when the mode authorizes mutation", (cmd) => {
    expect(writeMode(cmd).action).toBe("auto_allow");
  });

  it("the default is the write mode, so an un-updated caller cannot tighten silently", () => {
    // `readOnlySource` defaults to false precisely so adding the parameter
    // could not change Build/Debug behaviour anywhere it was not passed.
    expect(resolveRunCommandPermissionGate("git commit -m x", APP, WS)).toEqual(
      writeMode("git commit -m x"),
    );
  });
});

describe("rules still work, and stay in their own namespace", () => {
  it("an always-allow for the mutation key lets it auto-run", () => {
    expect(readOnly("git commit -m x").action).toBe("prompt");
    decisions.set(`${APP}:mutate:git-write`, "always_allow");
    expect(readOnly("git commit -m x").action).toBe("auto_allow");
  });

  it("a coarse 'always allow git' does NOT satisfy a mutation key", () => {
    // Same invariant `danger:` upholds. Allowing `git` as a category is a
    // statement about reading git, not about rewriting the working tree.
    decisions.set(`${APP}:git`, "always_allow");
    expect(readOnly("git commit -m x").action).toBe("prompt");
  });

  it("allowing redirects does not allow rewriting git hooks", () => {
    decisions.set(`${APP}:mutate:redirect`, "always_allow");
    expect(readOnly("echo x > notes.txt").action).toBe("auto_allow");
    expect(readOnly("echo x > .git/hooks/pre-commit").action).toBe("prompt");
  });

  it("an always-deny on the mutation key blocks outright", () => {
    decisions.set(`${APP}:mutate:git-write`, "always_deny");
    expect(readOnly("git commit -m x").action).toBe("auto_deny");
  });
});

describe("preflight carries the reason through", () => {
  it("prompt carries reason 'mutation'", () => {
    const pf = runCommandCategoryPreflight(
      "mv src/a.ts src/b.ts",
      APP,
      WS,
      true,
    );
    expect(pf).toMatchObject({ type: "prompt", reason: "mutation" });
  });

  it("a read-only preflight auto-allows a build", () => {
    expect(
      runCommandCategoryPreflight("npm run build", APP, WS, true),
    ).toMatchObject({ type: "auto_allow" });
  });
});

// Coordinator's review of 08458785 (2026-10-20): a wrapper with options in
// front (`nice -n 10`, `timeout 5`, `env -i`) or an alias defined inline
// (`git -c alias.x='reset --hard' x`) still hid what runs. Asserted at the
// GATE, so a case another rule already covers is not counted as a gap.
describe("what runs behind a wrapper, or behind an inline git alias, still asks", () => {
  const wrapped = [
    "nice -n 10 git reset -q --hard",
    "timeout 5 git reset -q --hard",
    "timeout -s KILL 5 git reset -q --hard",
    "env -i git reset -q --hard",
    "env -u HOME git reset -q --hard",
    "time -p git reset -q --hard",
    "exec git reset -q --hard",
    "xargs git reset -q --hard",
    "stdbuf -oL git reset -q --hard",
    "env -S 'git reset -q --hard'",
  ];
  it("Build: the danger behind a wrapper asks", () => {
    for (const cmd of wrapped) expect(writeMode(cmd).action, cmd).toBe("prompt");
  });
  it("Explore: a change behind a wrapper asks", () => {
    for (const cmd of [
      "nice -n 10 git commit -m x",
      "timeout 5 git commit -m x",
      "env -i git commit -m x",
      "time -p git commit -m x",
      "xargs -0 git add",
      "stdbuf -oL npm pkg set version=2.0.0",
    ]) {
      expect(readOnly(cmd).action, cmd).toBe("prompt");
    }
  });
  it("an alias defined inline asks in both, whatever it names", () => {
    for (const cmd of [
      "git -c alias.nuke='reset --hard' nuke",
      "git -c 'alias.st=status' st",
      "git --config-env=alias.x=MY_ALIAS x",
    ]) {
      expect(writeMode(cmd).action, cmd).toBe("prompt");
      expect(readOnly(cmd).action, cmd).toBe("prompt");
    }
  });
  it("a wrapper around a read is still a read", () => {
    for (const cmd of ["nice -n 10 git status", "timeout 5 git log -3", "env -i git diff", "time -p npm test"]) {
      expect(readOnly(cmd).action, cmd).toBe("auto_allow");
    }
  });
});
