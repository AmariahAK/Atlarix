import { describe, expect, it } from "vitest";
import { computeSessionEditTarget } from "@/ipc/handlers/workspace_session_handlers";

type Row = { id: string; role: string; kind: string | null };

const r = (id: string, role: string, kind: string | null = "message"): Row => ({
  id,
  role,
  kind,
});

describe("computeSessionEditTarget", () => {
  it("maps an edited message to its row and truncates the tail (no offset)", () => {
    const rows = [
      r("u1", "user"),
      r("a1", "assistant"),
      r("u2", "user"),
      r("a2", "assistant"),
    ];
    // ephemeral mirrors all 4 rows; editing u2 (index 2)
    const res = computeSessionEditTarget(rows, 2, 4);
    expect(res).toEqual({ targetId: "u2", deleteIds: ["a2"] });
  });

  it("accounts for the load-window offset (DB has more rows than ephemeral)", () => {
    const rows = [
      r("u0", "user"),
      r("a0", "assistant"),
      r("u1", "user"),
      r("a1", "assistant"),
      r("u2", "user"),
      r("a2", "assistant"),
    ];
    // ephemeral loaded only the last 4 (u1,a1,u2,a2); editing the ephemeral idx 2 (= u2)
    const res = computeSessionEditTarget(rows, 2, 4);
    expect(res).toEqual({ targetId: "u2", deleteIds: ["a2"] });
  });

  it("excludes plan/tool rows from the ordinal but still deletes them in the tail", () => {
    const rows = [
      r("u1", "user"),
      r("a1", "assistant"),
      r("p1", "assistant", "plan"),
      r("u2", "user"),
      r("a2", "assistant"),
    ];
    // ephemeral has u1,a1,u2,a2 (plan excluded); editing idx 2 (= u2)
    const res = computeSessionEditTarget(rows, 2, 4);
    expect(res?.targetId).toBe("u2");
    expect(res?.deleteIds).toEqual(["a2"]);
  });

  it("deletes everything after an earlier edited message", () => {
    const rows = [
      r("u1", "user"),
      r("a1", "assistant"),
      r("u2", "user"),
      r("a2", "assistant"),
    ];
    // edit the first user message (idx 0) → everything after is regenerated
    const res = computeSessionEditTarget(rows, 0, 4);
    expect(res).toEqual({ targetId: "u1", deleteIds: ["a1", "u2", "a2"] });
  });

  it("returns null for an unmappable index", () => {
    const rows = [r("u1", "user"), r("a1", "assistant")];
    expect(computeSessionEditTarget(rows, -1, 2)).toBeNull();
    expect(computeSessionEditTarget(rows, 5, 2)).toBeNull();
  });
});
