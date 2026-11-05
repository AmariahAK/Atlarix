/**
 * What changes turn to turn rides the per-turn tail, never the cached header
 * (token saving, owner 2026-11-05; Codex and opencode send changes as new
 * input instead of rewriting the prefix). One changed byte in the header
 * re-writes the whole cached prefix: the plan was rebuilt into it every turn.
 */
import { describe, expect, it } from "vitest";
import { buildPromptBundle } from "@/ipc/handlers/chat_stream/turn-runner/prompt-bundle";
import { joinSystemPromptParts, splitDynamicTail } from "@/prompts/system_prompt";
import type { ContextSection } from "@/lib/context/ContextAssembler";

const HEADER = "# Header\nstable rules";
const TAIL = "Today is Thursday.";
const event = { sender: { send: () => {}, isDestroyed: () => false } } as never;

async function bundle(opts: { plan?: string; image?: boolean; chatId?: number }) {
  const sections: ContextSection[] = [
    { name: "skillsIndex", priority: -2, content: "# Skills\n- a skill" },
    ...(opts.plan ? [{ name: "activePlan" as const, priority: 3, content: `# Active plan\n${opts.plan}` }] : []),
  ];
  const b = await buildPromptBundle(sections, {
    req: {
      chatId: opts.chatId ?? 41,
      prompt: "go",
      attachments: opts.image ? [{ name: "shot.png", type: "image/png", data: "x", attachmentType: "chat-context" }] : [],
    } as never,
    event,
    effectiveAppId: null,
    effectiveWorkMode: "build",
    userPrompt: "go",
    baseSystemPrompt: joinSystemPromptParts({ stableHeader: HEADER, dynamicTail: TAIL }),
    baseDynamicTail: TAIL,
    isSummarizeIntent: false,
    otherAppsCodebaseInfo: undefined,
  } as never);
  const split = splitDynamicTail(b.systemPrompt, b.dynamicTail);
  if (typeof split === "string") throw new Error("the tail was not found in the system prompt");
  return { header: split.systemPromptOverride, tail: split.dynamicSystemTail };
}

describe("the cached header stays byte-identical while the plan and attachments change", () => {
  it("the plan goes with the tail, not the header", async () => {
    const t1 = await bundle({ plan: "- [ ] step one", chatId: 51 });
    expect(t1.tail).toContain("- [ ] step one");
    expect(t1.tail).toContain(TAIL);
    expect(t1.header).not.toContain("Active plan");
    expect(t1.header).toContain("# Skills");
  });

  it("a ticked-off plan and an image this turn leave the header exactly as it was", async () => {
    const before = await bundle({ plan: "- [ ] step one", chatId: 52 });
    const after = await bundle({ plan: "- [x] step one", image: true, chatId: 53 });
    expect(after.header).toBe(before.header);
    expect(after.tail).toContain("- [x] step one");
    expect(after.tail).toContain("Image Analysis Instructions");
  });

  it("with nothing volatile, the tail is the plain per-turn tail", async () => {
    const t = await bundle({ chatId: 54 });
    expect(t.tail).toBe(TAIL);
  });
});
