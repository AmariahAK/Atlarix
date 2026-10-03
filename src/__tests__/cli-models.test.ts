import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterOptions,
  groupOptions,
  readCliState,
  rememberChoice,
  toggleFavorite,
  writeCliState,
  type ModelOption,
} from "@/cli/agent/models";

const opt = (provider: string, name: string, label: string, providerName = provider): ModelOption => ({
  provider,
  name,
  label,
  providerName,
  detail: "",
  deepThinking: false,
});

const options = [
  opt("compass", "core-auto", "Atlarix Auto", "Atlarix"),
  opt("compass", "core-1", "GLM-5.3 (Z.ai)", "Atlarix"),
  opt("anthropic", "claude-opus-5-5", "Claude Opus 5.5", "Anthropic"),
  opt("openai", "gpt-6-luna", "GPT-6 Luna", "OpenAI"),
];

describe("/model", () => {
  it("groups like opencode: favourites, recent, then providers, Atlarix first", () => {
    const groups = groupOptions(options, {
      favorites: [{ provider: "openai", name: "gpt-6-luna" }],
      recent: [{ provider: "anthropic", name: "claude-opus-5-5" }],
    });
    // Each model once: Anthropic's and OpenAI's only models are already under Favourites and Recent.
    expect(groups.map((g) => g.title)).toEqual(["Favourites", "Recent", "Atlarix"]);
    const all = groups.flatMap((g) => g.options.map((o) => `${o.provider}/${o.name}`));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(options.length);
  });

  it("search is one flat list, names that start with the query first", () => {
    expect(filterOptions(options, "gpt").map((o) => o.name)).toEqual(["gpt-6-luna"]);
    expect(filterOptions(options, "atlarix").map((o) => o.name)).toEqual(["core-auto", "core-1"]);
    expect(filterOptions(options, "opus anthropic").map((o) => o.name)).toEqual(["claude-opus-5-5"]);
  });

  it("remembers the choice and recents, toggles favourites, in its own file", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-state-")), "cli-state.json");
    let s = readCliState(file);
    s = rememberChoice(s, { provider: "openai", name: "gpt-6-luna" });
    s = rememberChoice(s, { provider: "compass", name: "core-auto" });
    s = toggleFavorite(s, { provider: "openai", name: "gpt-6-luna" });
    writeCliState(s, file);
    const back = readCliState(file);
    expect(back.model).toEqual({ provider: "compass", name: "core-auto" });
    expect(back.recent.map((r) => r.name)).toEqual(["core-auto", "gpt-6-luna"]);
    expect(back.favorites).toEqual([{ provider: "openai", name: "gpt-6-luna" }]);
    expect(toggleFavorite(back, { provider: "openai", name: "gpt-6-luna" }).favorites).toEqual([]);
  });
});
