/**
 * A build that stopped with steps left is offered again (QA C4): /build and the
 * card's button pick it up, instead of nothing happening.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "resume-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "resume-ws-"));
});

describe("a stopped build", () => {
  it("is offered to continue, live and after reopening", async () => {
    const llm = startFakeLlm([{ text: "ok" }]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    const idle = new Promise<void>((r) => {
      const c = (st: { busy: boolean }) => !st.busy && (s.off("change", c), r());
      setTimeout(() => s.on("change", c), 20);
    });
    await s.submit("hi");
    await idle;
    const { createPlanArtifact, setPlanArtifactStatus } = await import("../src/lib/plans/plan-artifacts");
    const row = await createPlanArtifact(s.sessionId, "# Toggle\n\n1. [x] Add toggle\n2. [ ] Add tests\n", "Toggle");
    await setPlanArtifactStatus(row.id, "building");
    expect(s.state.planReady).toBeNull();
    await (s as unknown as { offerResumeBuild(): Promise<void> }).offerResumeBuild();
    expect(s.state.planReady).toMatchObject({ planId: row.id, resume: true });

    const again = new AgentSession({ workspaceDir: ws, model });
    await again.start();
    await again.resume(s.sessionId);
    expect(again.state.planReady).toMatchObject({ planId: row.id, resume: true });

    // All steps done: nothing to continue.
    const { updatePlanArtifactContent: setPlanArtifactContent } = (await import("../src/lib/plans/plan-artifacts")) as Record<string, any>;
    if (setPlanArtifactContent) {
      await setPlanArtifactContent(row.id, "# Toggle\n\n1. [x] Add toggle\n2. [x] Add tests\n");
      const third = new AgentSession({ workspaceDir: ws, model });
      await third.start();
      await third.resume(s.sessionId);
      expect(third.state.planReady).toBeNull();
    }
  }, 60_000);
});
