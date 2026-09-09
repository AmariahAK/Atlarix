/**
 * A rule saved mid-batch applies to what is ALREADY WAITING.
 *
 * The reported behaviour: *"always allow works when it's asked once, but if a
 * batch of file changes come in a row, all will not work, so I'll still be
 * asked."* Confirmed in the logs — 10 `always_allow_extension` and 4
 * `always_allow_file` decisions on one day, and `css.spec.ts` still asked 5
 * times, `css.ts` 4 times.
 *
 * Cause: the gate runs when an operation is REQUESTED, the rule is written when
 * one is DECIDED, and nothing revisited the queue in between.
 */
import { describe, it, expect } from "vitest";
import {
  selectOperationsCoveredByRules,
  describeSweptOperations,
  type PendingFileOperation,
  type SweepVerdict,
} from "@/lib/tools/permissions/pending-rule-sweep";

const op = (
  id: string,
  relativePath: string,
  operation = "edit_file",
): PendingFileOperation => ({
  id,
  operation,
  relativePath,
});

/** Stands in for the persisted rules the real preflight reads. */
const byExtension =
  (ext: string) =>
  (_operation: string, rel: string): SweepVerdict =>
    rel.endsWith(ext) ? "auto_allow" : "prompt";

describe("selectOperationsCoveredByRules", () => {
  /** The exact case reported: "always allow .ts" must clear the queued .ts edits. */
  it("sweeps up every queued edit the new extension rule covers", () => {
    const pending = [
      op("1", "src/a.ts"),
      op("2", "src/b.ts"),
      op("3", "src/styles.css"),
      op("4", "src/nested/deep/c.ts"),
    ];
    const covered = selectOperationsCoveredByRules(pending, byExtension(".ts"));
    expect(covered.map((c) => c.id)).toEqual(["1", "2", "4"]);
  });

  it("leaves everything else still asking", () => {
    const pending = [op("1", "src/a.ts"), op("2", "src/styles.css")];
    const covered = selectOperationsCoveredByRules(pending, byExtension(".ts"));
    expect(covered.map((c) => c.relativePath)).not.toContain("src/styles.css");
  });

  /** A folder rule should clear that folder's queued edits, whatever their type. */
  it("sweeps a directory rule across mixed file types", () => {
    const pending = [
      op("1", "packages/vite/src/a.ts"),
      op("2", "packages/vite/src/b.css"),
      op("3", "playground/other.ts"),
    ];
    const covered = selectOperationsCoveredByRules(pending, (_o, rel) =>
      rel.startsWith("packages/vite/") ? "auto_allow" : "prompt",
    );
    expect(covered.map((c) => c.id)).toEqual(["1", "2"]);
  });

  /** Several queued edits to the SAME file — the other reported shape. */
  it("sweeps repeated edits to one file", () => {
    const pending = [
      op("1", "src/css.ts"),
      op("2", "src/css.ts"),
      op("3", "src/other.ts"),
    ];
    const covered = selectOperationsCoveredByRules(pending, (_o, rel) =>
      rel === "src/css.ts" ? "auto_allow" : "prompt",
    );
    expect(covered.map((c) => c.id)).toEqual(["1", "2"]);
  });

  /**
   * The safety property. A deny verdict is NOT acted on: the user is mid-decision
   * on this batch, and silently rejecting queued work is a worse surprise than
   * leaving the card up. Only auto-allows are ever returned.
   */
  it("never acts on a deny verdict", () => {
    const pending = [op("1", "secrets/a.ts"), op("2", "src/b.ts")];
    const covered = selectOperationsCoveredByRules(pending, (_o, rel) =>
      rel.startsWith("secrets/") ? "auto_deny" : "auto_allow",
    );
    expect(covered.map((c) => c.id)).toEqual(["2"]);
  });

  it("returns nothing when the new rule covers nothing queued", () => {
    const pending = [op("1", "src/a.py")];
    expect(selectOperationsCoveredByRules(pending, byExtension(".ts"))).toEqual(
      [],
    );
    expect(selectOperationsCoveredByRules([], byExtension(".ts"))).toEqual([]);
  });

  it("skips an operation with no usable path rather than guessing", () => {
    const covered = selectOperationsCoveredByRules(
      [op("1", "")],
      () => "auto_allow",
    );
    expect(covered).toEqual([]);
  });
});

describe("describeSweptOperations", () => {
  /** The user still gets told — the fix is to stop ASKING, not to stop telling. */
  it("names how many the rule covered", () => {
    expect(describeSweptOperations(["a.ts", "b.ts", "c.ts"])).toBe(
      "3 more edits auto-approved by this rule",
    );
  });

  it("singularises", () => {
    expect(describeSweptOperations(["a.ts"])).toBe(
      "1 more edit auto-approved by this rule",
    );
  });
});
