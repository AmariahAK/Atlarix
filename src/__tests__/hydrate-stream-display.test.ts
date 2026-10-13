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

// A snapshot can now hold only the reply's model (QA #49). Its empty thread
// must not hide steps rebuilt from the content, as having no snapshot did.
describe("a snapshot holding only the model", () => {
  it("still rebuilds the steps from the reply's tags", () => {
    const content =
      '<atlarix-tool-call tool="read_file" call-id="c1">{"path":"a.ts"}</atlarix-tool-call><atlarix-tool-result tool="read_file" call-id="c1">ok</atlarix-tool-result>\n\nDone.';
    const bare = hydrateStreamDisplayForMessages([{ id: 1, role: "assistant", content }]);
    const withModel = hydrateStreamDisplayForMessages([
      {
        id: 1,
        role: "assistant",
        content,
        displaySnapshot: { version: 1, completedThread: [], model: { provider: "z-ai", name: "glm-5.3" } },
      },
    ]);
    expect(Object.keys(bare.completedThreads)).toEqual(["1"]);
    expect(withModel.completedThreads).toEqual(bare.completedThreads);
  });
});
