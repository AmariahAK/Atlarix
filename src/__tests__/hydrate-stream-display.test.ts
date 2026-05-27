import { describe, expect, it } from "vitest";
import { hydrateStreamDisplayForMessages } from "@/lib/chat/hydrate-stream-display";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";

describe("hydrateStreamDisplayForMessages", () => {
  it("prefers persisted display snapshot over tag rebuild", () => {
    const snapshot: DisplaySnapshotV1 = {
      version: 1,
      completedThread: [
        {
          kind: "subagent_round",
          id: "round-1",
          agents: [
            {
              id: "a1",
              agentType: "explore",
              label: "explore · /repo",
              scope: "/repo",
              status: "done",
              nestedItems: [],
            },
          ],
          status: "done",
          ts: 1,
        },
      ],
    };

    const { completedThreads } = hydrateStreamDisplayForMessages([
      {
        id: 42,
        role: "assistant",
        content: "<think>legacy</think>",
        displaySnapshot: snapshot,
      },
    ]);

    expect(completedThreads[42]?.some((i) => i.kind === "subagent_round")).toBe(
      true,
    );
  });
});
