/**
 * One session answers another's plan awaiting approval (item 11), end to end:
 * the real tools, inbox and socket, main's checks, and the target. Approve is
 * the user's Build (plan building, session in Build, the build turn starts);
 * reject keeps the plan and delivers why; update replaces the text; all three
 * refused while the target's turn runs.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "peer-plan-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "peer-plan-ws-"));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = async (s: { state: { busy: boolean }; sessionId: string }) => {
  for (let i = 0; i < 300 && (s.state.busy || !s.sessionId); i++) await wait(100);
};

type Result = { success: boolean; text?: string; error?: string };
const run = async (tool: string, args: Record<string, unknown>): Promise<Result> => {
  const { ToolRegistry } = await import("../src/lib/tools/registry");
  await import("../src/lib/tools/peers");
  let raw = (await ToolRegistry.execute(tool, args)) as unknown;
  while (raw && typeof raw === "object" && "result" in raw && typeof (raw as { result: unknown }).result === "object") {
    raw = (raw as { result: unknown }).result;
  }
  return raw as Result;
};

describe("a session answers another's plan", () => {
  it("lists it, shows it, refuses what it must, and approve builds it", async () => {
    const llm = startFakeLlm([{ text: "Coordinating." }, { text: "Planning." }, { text: "Building now." }]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const coord = new AgentSession({ workspaceDir: ws, model });
    const guard = new AgentSession({ workspaceDir: ws, model });
    await coord.start();
    await guard.start();
    await coord.submit("hi");
    await idle(coord);
    await guard.submit("hi");
    await idle(guard);
    for (let i = 0; i < 50; i++) {
      const { peerInboxRunning } = await import("../src/lib/peers/peers");
      if (peerInboxRunning()) break;
      await wait(100);
    }
    await coord.rename("Rix");
    await guard.rename("Guard");
    const as = { workspaceSessionId: coord.sessionId };

    // No plan yet: refused.
    const none = await run("send_message", { to: "Guard", plan: "approve", ...as });
    expect(none.success).toBe(false);
    expect(none.error).toContain("Guard has no plan awaiting approval");

    const plans = await import("../src/lib/plans/plan-artifacts");
    const p = await plans.createPlanArtifact(guard.sessionId, "- [ ] Add the login page\n- [ ] Test it", "Login page");

    const list = await run("list_sessions", { plan_of: "Guard", ...as });
    expect(list.text).toContain("· plan to review: Login page");
    expect(list.text).toContain("Plan of Guard (awaiting approval): Login page\n- [ ] Add the login page");

    // Refusals change nothing.
    expect((await run("send_message", { to: "Guard", plan: "reject", ...as })).error).toContain("A reject needs a message");
    expect((await run("send_message", { to: "Guard", plan: "update", ...as })).error).toContain("update needs plan_text");
    expect((await run("send_message", { to: "Guard", plan: "approve", mode: "plan", ...as })).error).toContain(
      "approve builds the plan in Build",
    );
    const { activeStreams } = await import("../src/ipc/handlers/chat_stream/stream-state");
    const { db } = await import("../src/db");
    const { chatSessions } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const row = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, guard.sessionId) });
    activeStreams.set(row!.streamChatId, new AbortController() as never);
    const busy = await run("send_message", { to: "Guard", plan: "update", plan_text: "- [ ] x", ...as });
    activeStreams.delete(row!.streamChatId);
    expect(busy.success).toBe(false);
    expect(busy.error).toContain("Guard is busy; answer its plan when its turn ends");
    expect((await plans.getPlanArtifact(p.id))?.content).toContain("Add the login page");

    // Update: replaced, still waiting.
    const upd = await run("send_message", { to: "Guard", plan: "update", plan_text: "- [ ] Add the login page\n- [ ] Add a logout", ...as });
    expect(upd.success).toBe(true);
    expect(upd.text).toContain("Plan updated by Rix. It's waiting for approval.");
    expect((await plans.getPlanArtifact(p.id))).toMatchObject({ planStatus: "plan", content: "- [ ] Add the login page\n- [ ] Add a logout" });
    expect((await plans.getPlanArtifact(p.id))?.title).toBe("Login page");
    await run("send_message", { to: "Guard", plan: "update", plan_text: "# Login and logout\n- [ ] Add the login page\n- [ ] Add a logout", ...as });
    expect((await plans.getPlanArtifact(p.id))).toMatchObject({ title: "Login and logout", planStatus: "plan" });

    // Reject: kept, and why arrives.
    const rej = await run("send_message", { to: "Guard", plan: "reject", message: "Split logout out.", ...as });
    expect(rej.success).toBe(true);
    expect((await plans.getPlanArtifact(p.id))?.planStatus).toBe("plan");
    for (let i = 0; i < 50 && !JSON.stringify(guard.state.cells).includes("Plan rejected by Rix"); i++) await wait(100);
    expect(JSON.stringify(guard.state.cells)).toContain("Plan rejected by Rix.");
    await idle(guard);

    // Approve: building, Build, and the build turn ran.
    const ok = await run("send_message", { to: "Guard", plan: "approve", ...as });
    expect(ok.success).toBe(true);
    expect(ok.text).toContain("Plan approved by Rix. Building it.");
    expect((await plans.getPlanArtifact(p.id))?.planStatus).toBe("building");
    for (let i = 0; i < 50 && guard.state.mode !== "build"; i++) await wait(100);
    expect(guard.state.mode).toBe("build");
    // The build turn ran, shown as the CLI shows its own Build.
    const after = () => guard.state.cells.slice(guard.state.cells.findIndex((c) => c.text === "◇ Plan approved by Rix. Building it."));
    for (let i = 0; i < 100 && !after().some((c) => c.kind === "footer"); i++) await wait(100);
    expect(after().map((c) => c.text)).toContain("▸ Build it");
    expect(after().find((c) => c.kind === "footer")?.text).toStartWith("Build · fake-model");
    expect((await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, guard.sessionId) }))?.workMode).toBe("build");

    await coord.close();
    await guard.close();
    llm.close?.();
  }, 120_000);
});
