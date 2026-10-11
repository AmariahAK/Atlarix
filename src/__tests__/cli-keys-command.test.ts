/**
 * `atlarix keys`: where Zed and JetBrains send people to add a key, so a key is
 * typed into a terminal and never into a chat. A key is checked before it is
 * saved, and a rejected one is not saved.
 */
import { describe, expect, it } from "vitest";
import { findProvider, runKeysCommand } from "@/cli/keys-command";
import type { CliServices, KeyCheck, ProviderSummary } from "@/cli/agent/services";

function fake(list: ProviderSummary[], verdict: (key?: string) => KeyCheck) {
  const calls: string[] = [];
  const services: Pick<CliServices, "providers"> = {
    providers: {
      list: async () => list,
      saveKey: async (id, key) => void calls.push(`save ${id} ${key}`),
      removeKey: async (id) => void calls.push(`remove ${id}`),
      test: async (_id, key) => verdict(key),
      addCustom: async () => ({ id: "", models: 0 }),
      setEnabled: async () => {},
      local: async () => [],
    },
  };
  let out = "";
  const io = { out: (s: string) => void (out += s), readKey: async () => "sk-typed-key-123456" };
  return { services, calls, io, output: () => out };
}

const OPENAI: ProviderSummary = { id: "openai", name: "OpenAI", hasKey: true, keyHint: "sk-…UcIA" };
const DEEPSEEK: ProviderSummary = { id: "deepseek", name: "DeepSeek", hasKey: false, keyUrl: "https://platform.deepseek.com" };

describe("atlarix keys", () => {
  it("lists each saved key with what its provider said", async () => {
    const f = fake([OPENAI, DEEPSEEK], () => ({ status: "rejected", detail: "Incorrect API key" }));
    expect(await runKeysCommand([], f.services, f.io)).toBe(0);
    expect(f.output()).toContain("OpenAI");
    expect(f.output()).toContain("rejected: Incorrect API key");
    expect(f.output()).not.toContain("DeepSeek");
  });

  it("add: checks the typed key first, and saves only one that isn't rejected", async () => {
    const ok = fake([OPENAI, DEEPSEEK], () => ({ status: "works", detail: "2 models" }));
    expect(await runKeysCommand(["add", "deepseek"], ok.services, ok.io)).toBe(0);
    expect(ok.calls).toEqual(["save deepseek sk-typed-key-123456"]);
    expect(ok.output()).toContain("https://platform.deepseek.com");

    const bad = fake([OPENAI, DEEPSEEK], () => ({ status: "rejected", detail: "invalid" }));
    expect(await runKeysCommand(["add", "DeepSeek"], bad.services, bad.io)).toBe(1);
    expect(bad.calls).toEqual([]);
    expect(bad.output()).toContain("Nothing saved");
  });

  it("remove forgets the key; an unknown or ambiguous name says so", async () => {
    const f = fake([OPENAI, DEEPSEEK, { id: "openrouter", name: "OpenRouter", hasKey: false }], () => ({ status: "works", detail: "" }));
    expect(await runKeysCommand(["remove", "openai"], f.services, f.io)).toBe(0);
    expect(f.calls).toEqual(["remove openai"]);
    expect(await runKeysCommand(["add", "nope"], f.services, f.io)).toBe(1);
    expect(await runKeysCommand(["add", "open"], f.services, f.io)).toBe(1);
    expect(f.output()).toContain("openai, openrouter");
  });

  it("finds a provider by id, name or an unambiguous start", () => {
    expect(findProvider([OPENAI, DEEPSEEK], "deep")).toBe(DEEPSEEK);
    expect(findProvider([OPENAI, DEEPSEEK], "OpenAI")).toBe(OPENAI);
    expect(findProvider([OPENAI, DEEPSEEK], "x")).toBeNull();
  });
});
