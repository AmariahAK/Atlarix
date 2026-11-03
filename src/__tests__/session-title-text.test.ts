import * as titleText from "@/lib/session-title/title-text";
/**
 * Session titles (v14.52.0) — the text rules and the model chain.
 *
 * The case that started it: DeepSeek V4 Pro titled "hey how are you? could u
 * tell me about yourself?" as "Hey! I'm doing well, thanks for asking. 😊 I'm
 * **DeepSeek V4 Pro**, running ins…". It must be rejected, and the placeholder
 * from the user's own words must stand instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deterministicTitle,
  looksLikeReplyNotTitle,
  sanitizeGeneratedTitle,
  titleUserPrompt,
  TITLE_MAX_CHARS,
  TITLE_SYSTEM_PROMPT,
  chatHeaderTitle,
  isPlaceholderTitle,
} from "@/lib/session-title/title-text";

describe("the prompt", () => {
  it("tells the model not to answer, and sends ONLY the first user message", () => {
    expect(TITLE_SYSTEM_PROMPT).toMatch(/Do not answer the request/);
    const p = titleUserPrompt("fix the login redirect");
    expect(p).toContain("<user_message>\nfix the login redirect\n</user_message>");
  });

  it("caps the first message it hands over", () => {
    expect(titleUserPrompt("x".repeat(5000)).length).toBeLessThan(1200);
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("strips think blocks, including an unclosed one", () => {
    expect(sanitizeGeneratedTitle("<think>hmm</think>Fix login redirect")).toBe(
      "Fix login redirect",
    );
    expect(sanitizeGeneratedTitle("Fix login redirect\n<think>still going")).toBe(
      "Fix login redirect",
    );
  });

  it("reads .title from JSON", () => {
    expect(sanitizeGeneratedTitle('{"title":"Dark mode toggle"}')).toBe(
      "Dark mode toggle",
    );
  });

  it("drops a label, markdown, quotes, emoji and a trailing period", () => {
    expect(sanitizeGeneratedTitle('Title: **"Add dark mode"** 🎉.')).toBe(
      "Add dark mode",
    );
  });

  it("keeps the first non-empty line and caps on a word boundary", () => {
    const t = sanitizeGeneratedTitle(
      "\n\nA really quite long title that keeps going well past the limit\nsecond",
    );
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(t.endsWith(" ")).toBe(false);
    expect(t).not.toContain("second");
  });
});

describe("looksLikeReplyNotTitle", () => {
  it("rejects the DeepSeek reply that started this", () => {
    const raw =
      "Hey! I'm doing well, thanks for asking. 😊 I'm **DeepSeek V4 Pro**, running ins";
    expect(looksLikeReplyNotTitle(sanitizeGeneratedTitle(raw), "deepseek-v4-pro")).toBe(
      true,
    );
  });

  it.each([
    "Sure, here is a title",
    "I can help with that",
    "What do you want to build?",
    "Fix login. Then add tests",
    "As an AI I cannot",
    "",
  ])("rejects %j", (t) => {
    expect(looksLikeReplyNotTitle(t)).toBe(true);
  });

  it("rejects a title that names the model itself", () => {
    expect(looksLikeReplyNotTitle("DeepSeek introduction", "deepseek-v4-pro")).toBe(
      true,
    );
  });

  it.each([
    ["User Safety: safe", "hey"],
    ["Requested title generation", "list the files here"],
    ["Generate title for one-word reply", "say kraken"],
  ])("rejects %j from a free model that wasn't writing a title (QA 15.7.1 #12)", (t, user) => {
    expect(looksLikeReplyNotTitle(t, "openrouter/free", user)).toBe(true);
  });

  it("keeps a title about titles when that is what the user asked", () => {
    expect(
      looksLikeReplyNotTitle("Blog post title ideas", "openrouter/free", "suggest a title for my blog post"),
    ).toBe(false);
  });

  it.each([
    "React useEffect runs twice",
    "Greeting and introduction",
    "Users table Postgres 16 migration",
    "Добавить gitignore и удалить секреты",
  ])("accepts %j", (t) => {
    expect(looksLikeReplyNotTitle(t, "deepseek-v4-pro")).toBe(false);
  });
});

describe("deterministicTitle (the instant placeholder)", () => {
  it("turns a bare greeting into Greeting", () => {
    expect(deterministicTitle("hey!!")).toBe("Greeting");
    expect(deterministicTitle("hello")).toBe("Greeting");
  });

  it("drops filler, code, URLs and mentions", () => {
    expect(
      deterministicTitle(
        "hey can you fix the login redirect in @/src/auth.ts see https://x.dev ```code```",
      ),
    ).toBe("Fix the login redirect in see");
  });

  it("is capped and capitalised", () => {
    const t = deterministicTitle(
      "refactor the entire billing pipeline so invoices are generated nightly and emailed",
    )!;
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(t[0]).toBe(t[0]!.toUpperCase());
  });

  it("returns null for a message that was only an attachment", () => {
    expect(deterministicTitle('<atlarix-text-attachment id="1" />')).toBeNull();
    expect(deterministicTitle("   ")).toBeNull();
  });

  it("strips leading glyphs from a quoted or listed line (owner, 2026-10-31)", () => {
    expect(deterministicTitle("› fix the login redirect")).toBe("Fix the login redirect");
    expect(deterministicTitle("- fix the login redirect")).toBe("Fix the login redirect");
    expect(deterministicTitle("· fix the login redirect")).toBe("Fix the login redirect");
    expect(deterministicTitle("> fix the login redirect")).toBe("Fix the login redirect");
  });
});

// ── the model chain ────────────────────────────────────────────────────────

const catalogRows = vi.fn();
vi.mock("@/lib/models_dev", () => ({
  getModelsDevCatalogRows: (...a: unknown[]) => catalogRows(...a),
}));
vi.mock("@/ipc/shared/compass_constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ipc/shared/compass_constants")>()),
  CORE_TIER_1: "core-1",
  CORE_TIER_AUTO: "core-auto",
  isCoreAutoTier: (n: string) => n === "core-auto",
  getCoreModelIdForCoreTier: (t: string) =>
    t === "core-auto" || t === "core-1" ? "glm-x" : undefined,
}));

import { resolveTitleModel } from "@/lib/session-title/generate-title";
import type { UserSettings } from "@/lib/schemas";

const settingsWith = (provider: string, name: string, extra = {}) =>
  ({ selectedModel: { provider, name }, ...extra }) as unknown as UserSettings;

describe("resolveTitleModel", () => {
  beforeEach(() => catalogRows.mockReset());

  it("BYOK: the cheapest small model on the user's OWN provider", async () => {
    catalogRows.mockResolvedValue([
      { apiName: "gpt-5", displayName: "GPT-5", cost: { input: 5, output: 20 } },
      { apiName: "gpt-5-mini", displayName: "GPT-5 mini", cost: { input: 1, output: 4 } },
      { apiName: "gpt-5-nano", displayName: "GPT-5 nano", cost: { input: 0.1, output: 0.4 } },
      { apiName: "gpt-image-mini", displayName: "Image mini", cost: { input: 0, output: 0 } },
    ]);
    expect(await resolveTitleModel(settingsWith("openai", "gpt-5"))).toEqual({
      provider: "openai",
      name: "gpt-5-nano",
    });
  });

  it("BYOK with NO small model on that provider: the same model writes the title", async () => {
    catalogRows.mockResolvedValue([
      { apiName: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", cost: { input: 1, output: 2 } },
    ]);
    expect(await resolveTitleModel(settingsWith("deepseek", "deepseek-v4-pro"))).toEqual({
      provider: "deepseek",
      name: "deepseek-v4-pro",
    });
  });

  it("BYOK never lands on Core", async () => {
    catalogRows.mockResolvedValue([]);
    const m = await resolveTitleModel(settingsWith("anthropic", "claude-x"));
    expect(m.provider).toBe("anthropic");
  });

  it("Auto stays on Auto; a paid Core tier also titles through Auto (helpers route by purpose, 2026-10-30), never a paid slot", async () => {
    expect(await resolveTitleModel(settingsWith("compass", "core-auto"))).toEqual({
      provider: "compass",
      name: "core-auto",
    });
    expect(await resolveTitleModel(settingsWith("compass", "core-4"))).toEqual({
      provider: "compass",
      name: "core-auto",
    });
  });

  it("a custom summarization model wins", async () => {
    const custom = { provider: "google", name: "gemini-flash-lite" };
    const s = settingsWith("openai", "gpt-5", {
      aiConfiguration: {
        contextSummarization: {
          summarizationModel: "custom",
          customSummarizationModel: custom,
        },
      },
    });
    expect(await resolveTitleModel(s)).toEqual(custom);
  });
});

describe("titleSourceText", () => {
  it("names a session from the paste, not its placeholder", () => {
    const { titleSourceText } = titleText;
    expect(titleSourceText("[Pasted text #1 +32 lines]", "fix the B008 false positive for frozen dataclasses")).toBe(
      "fix the B008 false positive for frozen dataclasses",
    );
    // Anything else: what you typed (the model text can hold whole attached files).
    expect(titleSourceText("explain this file", "explain this file\n<attached>…10k lines…</attached>")).toBe("explain this file");
  });
});

describe("the chat header's name (15.11 session naming)", () => {
  it("is the session's title, and nothing for a placeholder or the workspace's own name", () => {
    expect(chatHeaderTitle("Login page", "shop")).toBe("Login page");
    expect(chatHeaderTitle("  Untitled ", "shop")).toBe("");
    expect(chatHeaderTitle("New chat", "shop")).toBe("");
    expect(chatHeaderTitle("shop", "shop")).toBe("");
    expect(chatHeaderTitle(undefined, "shop")).toBe("");
    expect(isPlaceholderTitle("New conversation session")).toBe(true);
  });
});
