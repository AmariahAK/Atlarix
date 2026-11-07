/**
 * The model picker in every ACP editor: grouped (favourites, recent, then one
 * per provider, the terminal's order), each model once, with where it comes
 * from and its context.
 */
import { describe, expect, it } from "vitest";
import { modelGroups } from "@/cli/acp/agent";

const opt = (provider: string, name: string, providerName: string, extra: object = {}) => ({
  provider,
  name,
  label: name,
  providerName,
  detail: `${providerName} · 128K context`,
  deepThinking: false,
  ...extra,
});

describe("modelGroups", () => {
  const options = [
    opt("compass", "auto", "Atlarix", { free: true, detail: "Picks for you" }),
    opt("deepseek", "deepseek-flash", "DeepSeek"),
    opt("deepseek", "deepseek-pro", "DeepSeek"),
    opt("openai", "gpt-5", "OpenAI"),
  ];

  it("groups by provider, Atlarix first, with a description", () => {
    const g = modelGroups(options);
    expect(g.map((x) => x.name)).toEqual(["Atlarix", "DeepSeek", "OpenAI"]);
    expect(g[0]!.options[0]).toEqual({ value: "compass/auto", name: "auto", description: "Free · Picks for you" });
    expect(g[1]!.options.map((o) => o.value)).toEqual(["deepseek/deepseek-flash", "deepseek/deepseek-pro"]);
  });

  it("leads with favourites and recents, and shows each model once", () => {
    const g = modelGroups(options, { favorites: [{ provider: "openai", name: "gpt-5" }], recent: [{ provider: "deepseek", name: "deepseek-pro" }] });
    expect(g.map((x) => x.name)).toEqual(["Favourites", "Recent", "Atlarix", "DeepSeek"]);
    const values = g.flatMap((x) => x.options.map((o) => o.value));
    expect(new Set(values).size).toBe(values.length);
    expect(values).toHaveLength(4);
  });

  it("a bare option (the dev provider) still gets a group", () => {
    expect(modelGroups([{ provider: "dev", name: "fake", label: "Fake" }])).toEqual([
      { group: "dev", name: "dev", options: [{ value: "dev/fake", name: "Fake", _meta: { atlarix: { provider: "dev" } } }] },
    ]);
  });

  it("tells the editor each row's provider, wherever the row is listed", () => {
    const g = modelGroups(
      [...options, opt("openrouter", "qwen", "OpenRouter (BYOK)", { providerLabel: "OpenRouter", detail: "OpenRouter · 128K context" })],
      { favorites: [{ provider: "openrouter", name: "qwen" }], recent: [] },
    );
    const rows = g.flatMap((x) => x.options);
    const row = (value: string) => rows.find((o) => o.value === value)!;
    // Under Favourites, not its provider: the provider still rides along.
    expect(g[0]!.name).toBe("Favourites");
    expect(row("openrouter/qwen")).toEqual({
      value: "openrouter/qwen",
      name: "qwen",
      description: "OpenRouter · 128K context",
      _meta: { atlarix: { provider: "OpenRouter" } },
    });
    expect(row("deepseek/deepseek-pro")._meta).toEqual({ atlarix: { provider: "DeepSeek" } });
    // Atlarix keeps the plan, so its rows name no provider.
    expect(row("compass/auto")).not.toHaveProperty("_meta");
  });

  it("names a row's provider without the catalog's bracket, and a custom one as given", () => {
    const g = modelGroups([
      opt("anthropic", "claude", "Anthropic (Claude)"),
      opt("custom::work", "m", "Work (EU)"),
    ]);
    const rows = g.flatMap((x) => x.options);
    expect(rows.map((o) => o._meta)).toEqual([{ atlarix: { provider: "Anthropic" } }, { atlarix: { provider: "Work (EU)" } }]);
  });
});
