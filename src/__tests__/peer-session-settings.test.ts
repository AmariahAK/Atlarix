/**
 * One session sets another's mode and/or model (item 9, owner 2026-10-22):
 * send_message's `mode` and `model`, each optional alongside the message; only
 * models this user has set up; applied directly (Build included) from the
 * target's next turn, with a line saying who.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  __resetPeersForTests,
  noteLiveSession,
  noteSessionModel,
  resolvePeer,
  publishPeerState,
  sendPeerMessage,
  setDefaultModelLabel,
  setIdleMessagesWait,
  startPeerInbox,
  type PeerHost,
} from "@/lib/peers/peers";
import {
  matchModel,
  MODEL_LIST_MAX,
  modelNames,
  parseMode,
  planTitleOf,
  settingsNotice,
  shortModelList,
} from "@/lib/peers/session-settings";

describe("the rules", () => {
  it("takes a mode by the name people see or its id", () => {
    expect(parseMode("Explore")).toBe("ask");
    expect(parseMode("review")).toBe("review");
    expect(parseMode("BUILD")).toBe("build");
    expect(parseMode("yolo")).toBeNull();
  });

  it("takes only a model this user has set up, by its name, provider/name or id", () => {
    const set = [
      { provider: "compass", name: "core-auto", label: "Atlarix Auto" },
      { provider: "anthropic", name: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ];
    expect(matchModel("atlarix auto", set)).toMatchObject({ name: "core-auto" });
    expect(matchModel("anthropic/claude-haiku-4-5", set)).toMatchObject({ provider: "anthropic" });
    expect(matchModel("claude-haiku-4-5", set)).toMatchObject({ label: "Claude Haiku 4.5" });
    const no = matchModel("GPT-6 Astra", set);
    expect("error" in no && no.error).toContain("Models you can set: Atlarix Auto, Claude Haiku 4.5");
  });

  it("two models with one label: each named with its provider, and a bare name is refused, never the first (QA E6)", () => {
    const set = [
      { provider: "atlarix-headless", name: "zai.glm-4.7-flash", label: "zai.glm-4.7-flash", providerName: "Atlarix Headless" },
      { provider: "custom::qa-bedrock", name: "zai.glm-4.7-flash", label: "zai.glm-4.7-flash", providerName: "qa-bedrock" },
    ];
    expect(modelNames(set).map((n) => n.name)).toEqual(["zai.glm-4.7-flash (Atlarix Headless)", "zai.glm-4.7-flash (qa-bedrock)"]);
    expect(matchModel("zai.glm-4.7-flash (qa-bedrock)", set)).toMatchObject({ provider: "custom::qa-bedrock" });
    const bare = matchModel("zai.glm-4.7-flash", set);
    expect("error" in bare && bare.error).toContain('say "zai.glm-4.7-flash (Atlarix Headless)" or "zai.glm-4.7-flash (qa-bedrock)"');
  });

  it("says who changed what, from the next turn", () => {
    expect(settingsNotice({ mode: "review" }, "Rix")).toBe("Mode set to Review by Rix. From the next turn.");
    expect(settingsNotice({ model: "Atlarix Auto" }, "Rix")).toBe("Model set to Atlarix Auto by Rix. From the next turn.");
    expect(settingsNotice({ mode: "ask", model: "Atlarix Auto" }, "Rix")).toBe(
      "Mode set to Explore and model to Atlarix Auto by Rix. From the next turn.",
    );
  });
});

// ── over the real socket, one process playing both ends ────────────────────
const sqlite = new DatabaseSync(":memory:");
const queued: Array<{ chatId: number; text: string }> = [];
const woken: number[] = [];
const applied: Array<{ chatId: number; set: { mode?: string; model?: string; plan?: string } }> = [];
let busyOnce = false;
const host: PeerHost = {
  isBusy: () => false,
  enqueue: (chatId, _id, text) => void queued.push({ chatId, text }),
  wake: (chatId) => void woken.push(chatId),
  inbound: () => "accept",
  applySettings: async (target, set, from) => {
    if (set.model === "not-set-up") return { ok: false, error: `"not-set-up" is not a model this user has set up` };
    if (set.plan && busyOnce) {
      busyOnce = false;
      return { ok: false, error: "Guard is busy; answer its plan when its turn ends" };
    }
    if (set.plan) {
      applied.push({ chatId: target.chatId, set });
      return { ok: true, notice: `Plan ${set.plan}d by ${from.name}.` };
    }
    applied.push({ chatId: target.chatId, set });
    return { ok: true, notice: settingsNotice({ mode: parseMode(set.mode) ?? undefined, model: set.model }, from.name) };
  },
};
const from = { sessionId: "sess-coord-0001", name: "Rix", surface: "cli" as const, workspace: "/w/a" };

beforeAll(async () => {
  await startPeerInbox({ surface: "cli", host, database: () => sqlite as never });
  noteLiveSession({ sessionId: "sess-guard-0002", chatId: -21, name: "Guard", workspace: "/w/b" });
  noteLiveSession({ sessionId: "sess-coord-0001", chatId: -22, name: "Rix", workspace: "/w/a" });
});
afterAll(() => __resetPeersForTests());

const guard = () => {
  const r = resolvePeer("Guard", "sess-coord-0001");
  if ("error" in r) throw new Error(r.error);
  return r.row;
};

describe("setting another session", () => {
  it("a mode alone: applied, nothing queued, nothing woken, and the sender is told the line", async () => {
    const r = await sendPeerMessage(guard(), from, "", { mode: "review" });
    expect(r).toEqual({ ok: true, applied: "Mode set to Review by Rix. From the next turn." });
    expect(applied.at(-1)).toEqual({ chatId: -21, set: { mode: "review" } });
    expect(queued).toHaveLength(0);
    expect(woken).toHaveLength(0);
  });

  it("Build too, directly (owner)", async () => {
    const r = await sendPeerMessage(guard(), from, "", { mode: "build" });
    expect(r.ok).toBe(true);
  });

  it("a model and a message: both applied and queued; without a reply asked, it does not wake", async () => {
    const r = await sendPeerMessage(guard(), from, "take the tests next", { model: "Atlarix Auto" });
    expect(r.ok).toBe(true);
    expect(applied.at(-1)!.set).toEqual({ model: "Atlarix Auto" });
    expect(queued.at(-1)!.text).toContain("take the tests next");
    // No notify_when_done: the message is queued for the next real turn, not
    // a fresh model call just to acknowledge (2026-10-31 spend incident).
    expect(woken).toHaveLength(0);
    expect(r.waits).toBe(true);
  });

  it("a model not set up there: refused, and the message with it is not delivered", async () => {
    const before = queued.length;
    const r = await sendPeerMessage(guard(), from, "and do this", { model: "not-set-up" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a model this user has set up");
    expect(queued).toHaveLength(before);
  });

  it("nothing at all is still refused", async () => {
    expect((await sendPeerMessage(guard(), from, "")).ok).toBe(false);
  });

  it("a plan answer is not a repeat of an earlier bare frame, and a refused one retried really applies (item 11)", async () => {
    busyOnce = true;
    const first = await sendPeerMessage(guard(), from, "", { plan: "update", planText: "- [ ] x" });
    expect(first).toEqual({ ok: false, error: "Guard is busy; answer its plan when its turn ends" });
    const retry = await sendPeerMessage(guard(), from, "", { plan: "update", planText: "- [ ] x" });
    expect(retry).toEqual({ ok: true, applied: "Plan updated by Rix." });
    const approve = await sendPeerMessage(guard(), from, "", { plan: "approve" });
    expect(approve.applied).toBe("Plan approved by Rix.");
  });

  it("a message to an idle session reads at its next turn; an editor that holds messages too", async () => {
    setIdleMessagesWait(() => true);
    try {
      expect((await sendPeerMessage(guard(), from, "read the spec")).waits).toBe(true);
    } finally {
      setIdleMessagesWait(() => false);
    }
    // Without notify_when_done an idle session is not woken: it reads the
    // message at its next real turn, so the sender is told it waits.
    expect((await sendPeerMessage(guard(), from, "and the tests")).waits).toBe(true);
  });
});

describe("the app's line above the composer (QA A13)", () => {
  it("a plan answer's line outlives the build turn it starts; a mode line goes at the next turn", async () => {
    const { noticeFor, noticeAfterTurnStart } = await import("@/lib/peers/peer-settings-window");
    const approved = noticeFor({ notice: "Plan approved by Rix. Building it.", plan: "approve" });
    const afterBuild = noticeAfterTurnStart(approved);
    expect(afterBuild?.text).toBe("Plan approved by Rix. Building it.");
    expect(noticeAfterTurnStart(afterBuild)).toBeUndefined();
    expect(noticeAfterTurnStart(noticeFor({ notice: "Mode set to Review by Rix. From the next turn." }))).toBeUndefined();
  });
});

describe("a long model list (QA, ai-b8)", () => {
  it("names at most MODEL_LIST_MAX and says how many more; every one can still be set", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ provider: "bedrock", name: `m${i}`, label: `Model ${i}` }));
    const listed = shortModelList(many.map((m) => m.label));
    expect(listed.split(" … ")[0]!.split(", ").length).toBe(MODEL_LIST_MAX);
    expect(listed).toContain(`and ${200 - MODEL_LIST_MAX} more`);
    expect(matchModel("Model 199", many)).toMatchObject({ name: "m199" });
    const no = matchModel("GPT-6 Astra", many);
    expect("error" in no && no.error.length).toBeLessThan(800);
  });
});

describe("an app chat's line carries the app's model (QA, ai-b8)", () => {
  it("a session with no model of its own is listed with the process's default; its own wins", () => {
    setDefaultModelLabel(() => "Claude Haiku 4.5");
    try {
      publishPeerState();
      const row = (id: string) =>
        sqlite.prepare("SELECT model FROM __atlarix_live_sessions WHERE session_id = ?").get(id) as { model: string };
      expect(row("sess-coord-0001").model).toBe("Claude Haiku 4.5");
      noteSessionModel("sess-coord-0001", "Glm 5.2");
      publishPeerState();
      expect(row("sess-coord-0001").model).toBe("Glm 5.2");
    } finally {
      setDefaultModelLabel(() => undefined);
    }
  });
});

describe("a replacing plan's title (QA, ai-95)", () => {
  it("its first heading, else none (the old one stays)", () => {
    expect(planTitleOf("# Add logout\n- [ ] x")).toBe("Add logout");
    expect(planTitleOf("\n## Split the login page ##\n- [ ] y")).toBe("Split the login page");
    expect(planTitleOf("- [ ] only steps\n# Later heading")).toBeUndefined();
  });
});

