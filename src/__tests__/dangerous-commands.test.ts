import { describe, expect, it } from "vitest";
import {
  isDangerousCommand,
  getDangerExplanation,
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
