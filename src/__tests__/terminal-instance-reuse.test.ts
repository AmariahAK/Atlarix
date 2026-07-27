/**
 * Foreground agent commands share ONE terminal tab.
 *
 * THE BUG: this rule existed only in TerminalPanel (renderer), as AGENT_FG_KEY.
 * The MAIN process ran its own policy at the same time — `openTerminalInstance`
 * looked up `agentOpMap[operationId]`, and since every `run_command` mints a
 * FRESH operationId, that reuse branch could never hit. So main created a new
 * instance for every single command, labelled "Agent N: <cmd>", and those extras
 * flowed back into the panel through the bidirectional scope sync. That is the
 * pile of tabs users saw.
 *
 * Past three, `MAX_AGENT_TERMINALS_PER_SCOPE` made main return an error which
 * `interceptor.executeRunCommand` discarded — so the command then ran with
 * nowhere to display its output, silently.
 *
 * Main now honours AGENT_FG_KEY (shared with the renderer via
 * lib/terminal-instances), so the two sides converge on one instance instead of
 * racing to create two.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => "/tmp/atlarix-terminal-reuse-test",
}));

import {
  getTerminalScopeState,
  openTerminalInstance,
  setTerminalScopeState,
} from "@/lib/terminal-instance-store";
import { AGENT_FG_KEY, AGENT_FG_LABEL } from "@/lib/terminal-instances";

/** A distinct scope per test, so cases can't leak into one another. */
let scopeSeq = 0;
function freshScope(): string {
  scopeSeq += 1;
  const key = `chat:-${scopeSeq}`;
  setTerminalScopeState(key, {
    instances: [],
    activeInstanceId: null,
    agentOpMap: {},
  });
  return key;
}

/** What the interceptor does for one run_command. */
function runCommand(
  scopeKey: string,
  command: string,
  opts: { background?: boolean } = {},
) {
  return openTerminalInstance(scopeKey, {
    owner: "agent",
    operationId: `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    commandHint: command,
    background: opts.background === true,
  });
}

describe("agent terminal reuse", () => {
  beforeEach(() => {
    scopeSeq += 100; // keep keys unique even across files
  });

  it("REGRESSION: five foreground commands share ONE tab", () => {
    const scope = freshScope();
    const ids = [
      runCommand(scope, "npm test"),
      runCommand(scope, "tsc --noEmit"),
      runCommand(scope, "git status"),
      runCommand(scope, "ls -la"),
      runCommand(scope, "cat package.json"),
    ].map((r) => (r.success ? r.instanceId : null));

    expect(new Set(ids).size).toBe(1);
    const agents = getTerminalScopeState(scope).instances.filter(
      (i) => i.owner === "agent",
    );
    expect(agents).toHaveLength(1);
  });

  it("names the shared tab for the session, not the command that opened it", () => {
    // "Agent 1: npm test" is wrong for a tab that then runs everything else.
    const scope = freshScope();
    runCommand(scope, "npm test");
    const agent = getTerminalScopeState(scope).instances.find(
      (i) => i.owner === "agent",
    );
    expect(agent?.label).toBe(AGENT_FG_LABEL);
  });

  it("registers the shared pointer so later commands can find it", () => {
    const scope = freshScope();
    const first = runCommand(scope, "npm test");
    const state = getTerminalScopeState(scope);
    expect(state.agentOpMap[AGENT_FG_KEY]).toBe(
      first.success ? first.instanceId : undefined,
    );
  });

  it("gives each background job its own tab", () => {
    // A dev server printing continuously must not interleave into the session
    // the agent is reading.
    const scope = freshScope();
    const fg = runCommand(scope, "npm test");
    const dev = runCommand(scope, "npm run dev", { background: true });
    const watch = runCommand(scope, "npm run watch", { background: true });

    const ids = [fg, dev, watch].map((r) => (r.success ? r.instanceId : null));
    expect(new Set(ids).size).toBe(3);
    expect(
      getTerminalScopeState(scope).instances.filter((i) => i.owner === "agent"),
    ).toHaveLength(3);
  });

  it("labels a background tab by its command", () => {
    const scope = freshScope();
    runCommand(scope, "npm run dev", { background: true });
    const agent = getTerminalScopeState(scope).instances.find(
      (i) => i.owner === "agent",
    );
    expect(agent?.label).toContain("npm run dev");
  });

  it("foreground commands after a background job still share the ONE tab", () => {
    const scope = freshScope();
    runCommand(scope, "npm run dev", { background: true });
    const a = runCommand(scope, "npm test");
    const b = runCommand(scope, "git diff");
    expect(a.success && b.success && a.instanceId === b.instanceId).toBe(true);
  });

  it("REGRESSION: a fourth agent terminal no longer fails", () => {
    // The old cap of 3 returned {success:false}, which the caller discarded.
    const scope = freshScope();
    const results = Array.from({ length: 6 }, (_, i) =>
      runCommand(scope, `server-${i}`, { background: true }),
    );
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("routes repeat events for the same operationId to the same tab", () => {
    // Later output events for a command must not open anything new.
    const scope = freshScope();
    const operationId = "op_stable";
    const first = openTerminalInstance(scope, {
      owner: "agent",
      operationId,
      commandHint: "npm test",
    });
    const second = openTerminalInstance(scope, {
      owner: "agent",
      operationId,
      commandHint: "npm test",
    });
    expect(second.success && !second.created).toBe(true);
    expect(first.success && second.success && first.instanceId === second.instanceId).toBe(
      true,
    );
  });

  it("honours a shared tab the RENDERER created and synced to main", () => {
    // The panel pre-creates the Agent tab so it is visible before the first
    // command. Main must adopt it rather than adding a second one.
    const scope = freshScope();
    setTerminalScopeState(scope, {
      instances: [
        {
          id: "agent-from-renderer",
          label: AGENT_FG_LABEL,
          owner: "agent",
          lines: [],
          createdAt: Date.now(),
        },
      ],
      activeInstanceId: "agent-from-renderer",
      agentOpMap: { [AGENT_FG_KEY]: "agent-from-renderer" },
    });

    const r = runCommand(scope, "npm test");
    expect(r.success && r.instanceId).toBe("agent-from-renderer");
    expect(
      getTerminalScopeState(scope).instances.filter((i) => i.owner === "agent"),
    ).toHaveLength(1);
  });

  it("an explicit terminal name gets its own tab, reused across calls", () => {
    // The point of targeting: a dev server holds one stream while tests run in
    // another, without a tab per command.
    const scope = freshScope();
    const a = openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op_a",
      commandHint: "playwright test",
      terminal: "e2e",
    });
    const b = openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op_b",
      commandHint: "playwright test --grep smoke",
      terminal: "e2e",
    });
    expect(a.success && b.success && a.instanceId === b.instanceId).toBe(true);
    const agents = getTerminalScopeState(scope).instances.filter(
      (i) => i.owner === "agent",
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]?.label).toBe("e2e");
  });

  it("a named terminal is separate from the shared foreground tab", () => {
    const scope = freshScope();
    const shared = runCommand(scope, "npm test");
    const named = openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op_named",
      commandHint: "npm run e2e",
      terminal: "e2e",
    });
    expect(shared.success && named.success && shared.instanceId !== named.instanceId).toBe(
      true,
    );
    // …and a later plain command still lands in the shared one, not the named.
    const back = runCommand(scope, "git status");
    expect(back.success && shared.success && back.instanceId === shared.instanceId).toBe(
      true,
    );
  });

  it("matches a target by id as well as by name", () => {
    const scope = freshScope();
    const made = openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op_1",
      terminal: "build",
    });
    const byId = openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op_2",
      terminal: made.success ? made.instanceId : "",
    });
    expect(byId.success && made.success && byId.instanceId === made.instanceId).toBe(true);
  });

  it("creates an unknown target rather than failing the command", () => {
    // A typo should cost a tab, not the command.
    const scope = freshScope();
    const r = openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op_typo",
      terminal: "tyops",
    });
    expect(r.success).toBe(true);
  });

  it("user shells are unaffected", () => {
    const scope = freshScope();
    openTerminalInstance(scope, { owner: "user" });
    openTerminalInstance(scope, { owner: "user" });
    const users = getTerminalScopeState(scope).instances.filter(
      (i) => i.owner === "user",
    );
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.label)).toEqual(["Shell 1", "Shell 2"]);
  });
});
