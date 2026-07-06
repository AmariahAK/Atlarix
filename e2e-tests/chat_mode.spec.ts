import { test } from "./helpers/test_helper";

test("chat mode selector - default build mode", async ({ po }) => {
  await po.setUp({ autoApprove: true });
  await po.importApp("minimal");

  await po.sendPrompt("[dump] hi");
  await po.waitForChatCompletion();

  await po.snapshotServerDump("all-messages");
  await po.snapshotMessages({ replaceDumpPath: true });
});

test("chat mode selector - ask mode", async ({ po }) => {
  await po.setUp({ autoApprove: true });
  await po.importApp("minimal");

  await po.selectChatMode("ask");
  await po.sendPrompt("[dump] hi");
  await po.waitForChatCompletion();

  await po.snapshotServerDump("all-messages");
  await po.snapshotMessages({ replaceDumpPath: true });
});

// The inline chat editor was removed with the Code tab (writes are applied via
// the Approve/Reject proposal flow, covered by approve.spec.ts) — this asserts
// the write card renders read-only in chat.
test("dyadwrite proposal renders in chat", async ({ po }) => {
  await po.setUp({ autoApprove: true });
  await po.importApp("minimal");
  await po.clickNewChat();

  await po.sendPrompt("Create a utility function in src/utils/helper.ts");
  await po.waitForChatCompletion();

  await po.snapshotMessages({ replaceDumpPath: true });
});
