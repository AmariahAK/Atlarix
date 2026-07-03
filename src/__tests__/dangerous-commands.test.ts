import { describe, expect, it } from "vitest";
import {
  isDangerousCommand,
  getDangerExplanation,
  dangerLabelKey,
  getDangerMatchIds,
  DANGEROUS_PATTERNS,
} from "@/lib/dangerous-commands";

describe("dangerous-commands — destructive git ops (v14.8.6)", () => {
  it("flags force-push variants so autonomous Build must confirm them", () => {
    expect(isDangerousCommand("git push --force")).toBe(true);
    expect(isDangerousCommand("git push origin main --force")).toBe(true);
    expect(isDangerousCommand("git push --force-with-lease")).toBe(true);
    expect(isDangerousCommand("git push origin main --force-with-lease")).toBe(true);
  });

  it("flags git reset --hard (discards uncommitted work)", () => {
    expect(isDangerousCommand("git reset --hard")).toBe(true);
    expect(isDangerousCommand("git reset --hard origin/main")).toBe(true);
  });

  it("distinguishes --force from --force-with-lease in the explanation", () => {
    expect(getDangerExplanation("git push --force")).toMatch(/OVERWRITE remote history/);
    expect(getDangerExplanation("git push --force-with-lease")).toMatch(/safety lease/);
  });

  it("leaves ordinary git commands alone", () => {
    expect(isDangerousCommand("git push")).toBe(false);
    expect(isDangerousCommand("git push origin main")).toBe(false);
    expect(isDangerousCommand("git status")).toBe(false);
    expect(isDangerousCommand("git reset HEAD~1")).toBe(false);
    expect(isDangerousCommand("git commit -m 'force the build'")).toBe(false);
  });
});

describe("dangerous-commands — pattern ids + dangerLabelKey (Fix 2 unification)", () => {
  it("every pattern has a unique, stable id", () => {
    const ids = DANGEROUS_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
  });

  it("dangerLabelKey is prefixed, deterministic, and sorted for multi-match", () => {
    expect(dangerLabelKey("git push --force-with-lease")).toBe(
      "danger:git-push-force-with-lease",
    );
    // Non-dangerous → null.
    expect(dangerLabelKey("git status")).toBeNull();
    // Multi-match (sudo pattern + rm-rf pattern + first-token rm/sudo) is sorted
    // and stable regardless of surface ordering.
    const a = dangerLabelKey("sudo rm -rf /tmp/x");
    const b = dangerLabelKey("sudo rm -rf /tmp/x");
    expect(a).toBe(b);
    expect(a?.startsWith("danger:")).toBe(true);
    const ids = getDangerMatchIds("sudo rm -rf /tmp/x");
    expect([...ids]).toEqual([...ids].sort()); // sorted
    expect(ids).toContain("rm-rf");
  });

  it("a coarse category can never collide with a danger key (distinct keys)", () => {
    // `git push --force` keys off its danger pattern, NOT the coarse "git"
    // category — so an always-allow of category "git" can't satisfy it.
    expect(dangerLabelKey("git push --force")).toBe("danger:git-push-force");
    expect(dangerLabelKey("git push --force")).not.toBe("git");
    // --force and --force-with-lease are DIFFERENT keys.
    expect(dangerLabelKey("git push --force")).not.toBe(
      dangerLabelKey("git push --force-with-lease"),
    );
  });

  it("migrated first-token dangers still register (no regression from retiring DANGEROUS_CATEGORIES)", () => {
    for (const cmd of [
      "kill 123",
      "pkill node",
      "chown root file",
      "chmod 777 x",
      "reboot",
      "shutdown -h now",
      "poweroff",
      "bash deploy.sh",
      "sh setup.sh",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sdb",
    ]) {
      expect(isDangerousCommand(cmd)).toBe(true);
    }
    // First-token key form.
    expect(dangerLabelKey("kill 123")).toBe("danger:cmd-kill");
    // Compound: first token is `ls` (not dangerous) so the trailing rm is NOT a
    // first-token match, mirroring the old first-token category semantics — but
    // the rm -rf PATTERN still catches it.
    expect(getDangerMatchIds("ls && rm -rf build")).toContain("rm-rf");
    expect(getDangerMatchIds("ls && rm -rf build")).not.toContain("cmd-rm");
  });
});
