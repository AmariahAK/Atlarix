/**
 * `sessions:hydrate-transport` join contract.
 *
 * Session load used to ship every message body BACK to main so main could rebuild
 * its own transport — `content` + `modelContent` + `displaySnapshot`, megabytes of it,
 * re-serialized in both directions for rows main had just read out of SQLite. Now the
 * renderer sends only what main cannot know: the numeric display id it allocated for
 * each row. Main joins the bodies itself.
 *
 * That makes the join the load-bearing part, so it is pinned here:
 *  - ORDER follows the renderer's refs, not the row array (edits and reverts target a
 *    message by its numeric id's position; a reordered transport mis-targets them)
 *  - an unmatched ref is DROPPED, never hydrated as an empty message (a blank message
 *    in the transport is sent to the model as real history)
 *  - `maxTokensUsed` survives (the context meter's ground truth on reload)
 */
import { describe, expect, it } from "vitest";
import {
  joinTransportRows,
  type SessionMessageRow,
} from "@/ipc/handlers/workspace_session_handlers";

function row(
  over: Partial<SessionMessageRow> & { id: string },
): SessionMessageRow {
  return {
    sessionId: "s1",
    role: "assistant",
    content: `content-${over.id}`,
    kind: "message",
    status: "complete",
    createdAt: new Date(0),
    displaySnapshot: null,
    modelContent: null,
    pasteAttachments: null,
    fileAttachments: null,
    snapshotTurnId: null,
    maxTokensUsed: null,
    ...over,
  } as SessionMessageRow;
}

describe("joinTransportRows", () => {
  it("takes order from the renderer's refs, not the row array", () => {
    // Rows deliberately arrive in the opposite order to the refs — this is what a
    // bare `SELECT` with no ORDER BY can do.
    const rows = [row({ id: "c" }), row({ id: "a" }), row({ id: "b" })];
    const out = joinTransportRows(rows, [
      { id: -1, sessionRowId: "a" },
      { id: -2, sessionRowId: "b" },
      { id: -3, sessionRowId: "c" },
    ]);
    expect(out.map((m) => m.sessionRowId)).toEqual(["a", "b", "c"]);
    expect(out.map((m) => m.id)).toEqual([-1, -2, -3]);
  });

  it("drops a ref with no matching row instead of emitting a blank message", () => {
    const out = joinTransportRows(
      [row({ id: "a" })],
      [
        { id: -1, sessionRowId: "a" },
        { id: -2, sessionRowId: "deleted-since-load" },
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.sessionRowId).toBe("a");
  });

  it("drops a ref with no sessionRowId at all", () => {
    const out = joinTransportRows(
      [row({ id: "a" })],
      [{ id: -1, sessionRowId: null }, { id: -2 }],
    );
    expect(out).toEqual([]);
  });

  it("carries maxTokensUsed through — the meter's ground truth", () => {
    const out = joinTransportRows(
      [row({ id: "a", maxTokensUsed: 130_411 })],
      [{ id: -1, sessionRowId: "a" }],
    );
    expect(out[0]?.maxTokensUsed).toBe(130_411);
  });

  it("carries modelContent through — the native tool history", () => {
    // Losing this is losing every file body, grep hit and command output the model
    // was holding, which is most of a coding session's context.
    const envelope = '{"messages":[{"role":"tool","content":"…"}]}';
    const out = joinTransportRows(
      [row({ id: "a", modelContent: envelope })],
      [{ id: -1, sessionRowId: "a" }],
    );
    expect(out[0]?.modelContent).toBe(envelope);
  });

  it("derives attachment info from stored file attachments", () => {
    const out = joinTransportRows(
      [
        row({
          id: "a",
          fileAttachments: [
            {
              id: "att-1",
              filename: "spec.pdf",
              mimeType: "application/pdf",
              size: 1234,
            },
          ] as SessionMessageRow["fileAttachments"],
        }),
      ],
      [{ id: -1, sessionRowId: "a" }],
    );
    expect(out[0]?.attachments).toEqual([
      {
        id: "att-1",
        filename: "spec.pdf",
        mimeType: "application/pdf",
        size: 1234,
      },
    ]);
  });

  it("normalizes absent optional fields to null rather than undefined", () => {
    // The transport spreads these conditionally; `undefined` vs `null` decides
    // whether a key is present at all.
    const out = joinTransportRows(
      [row({ id: "a" })],
      [{ id: -1, sessionRowId: "a" }],
    );
    expect(out[0]?.displaySnapshot).toBeNull();
    expect(out[0]?.modelContent).toBeNull();
    expect(out[0]?.attachments).toBeNull();
  });

  it("returns nothing for no refs", () => {
    expect(joinTransportRows([row({ id: "a" })], [])).toEqual([]);
  });
});
