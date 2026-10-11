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
      { group: "dev", name: "dev", options: [{ value: "dev/fake", name: "Fake" }] },
    ]);
  });
});
