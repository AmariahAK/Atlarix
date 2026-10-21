/**
 * The editor's Models & keys screen asks "does this key work?". The model
 * fetchers can't answer (they fall back to the catalog, so a revoked key still
 * lists models); this asks the provider and reads the status.
 */
import { describe, expect, it } from "vitest";
import { checkProviderKey, keyHint, keyProbe } from "@/lib/provider-key-check";

const reply = (status: number, body: unknown) =>
  (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("checking a saved key", () => {
  it("asks each kind of provider the way it authenticates", () => {
    expect(keyProbe("anthropic", "k")).toMatchObject({ url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": "k" } });
    expect(keyProbe("google", "k")?.headers).toEqual({ "x-goog-api-key": "k" });
    expect(keyProbe("openai", "k")).toMatchObject({ url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer k" } });
    expect(keyProbe("deepseek", "k", "https://api.deepseek.com/v1/")?.url).toBe("https://api.deepseek.com/v1/models");
    // Signed in through a cloud account, or nowhere to ask: not checkable.
    // A real Bedrock key is never probed (a key of the wrong form gets a warning: below).
    expect(keyProbe("bedrock", "ABSKQmVkcm9ja0FQSUtleS1abc", "https://x")).toBeNull();
    expect(keyProbe("someprovider", "k")).toBeNull();
  });

  it("works: the provider listed its models", async () => {
    const r = await checkProviderKey(keyProbe("openai", "sk-good")!, "sk-good", reply(200, { data: [{ id: "a" }, { id: "b" }] }));
    expect(r).toEqual({ status: "works", detail: "2 models" });
  });

  it("rejected: 401 and 403, and Google's 400 about the key, with the provider's words and never the key", async () => {
    const key = "sk-revoked-1234567890";
    const r = await checkProviderKey(keyProbe("openai", key)!, key, reply(401, { error: { message: `Incorrect API key provided: ${key}` } }));
    expect(r.status).toBe("rejected");
    expect(r.detail).toContain("Incorrect API key");
    expect(r.detail).not.toContain(key);
    expect((await checkProviderKey(keyProbe("x", "k", "https://x")!, "k", reply(403, "forbidden"))).status).toBe("rejected");
    const g = await checkProviderKey(keyProbe("google", "k")!, "k", reply(400, { error: { message: "API key not valid. Please pass a valid API key." } }));
    expect(g.status).toBe("rejected");
  });

  it("an endpoint with no model list can't be checked; an outage is not a bad key", async () => {
    expect((await checkProviderKey(keyProbe("x", "k", "https://x")!, "k", reply(404, "nope"))).status).toBe("unchecked");
    expect((await checkProviderKey(keyProbe("x", "k", "https://x")!, "k", reply(503, "down"))).status).toBe("unreachable");
    const offline = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect((await checkProviderKey(keyProbe("x", "k", "https://x")!, "k", offline)).status).toBe("unreachable");
    expect((await checkProviderKey(null, "k")).status).toBe("unchecked");
  });

  it("masks a key: enough to tell keys apart, never enough to use one", () => {
    expect(keyHint("sk-proj-abcdefghijklmnop1234")).toBe("sk-…1234");
    expect(keyHint("gsk_abcdefghijklmnopqrstuvwxyz9z8y")).toBe("gsk…9z8y");
    expect(keyHint("short-key")).toBe("••••");
    expect(keyHint("")).toBeUndefined();
  });
});

describe("an Amazon Bedrock key that can't be one (TODO, known limit from 15.9.0)", () => {
  // Bedrock can't be checked from here, so a typo only showed on the first message. Warn, and still
  // save: a format AWS adds later must not be locked out.
  const shortTerm = `bedrock-api-key-${"Y".repeat(40)}`;
  const longTerm = `ABSKQmVkcm9ja0FQSUtleS${"x".repeat(40)}`;

  it("says so, and is still only unchecked (saved)", async () => {
    const r = await checkProviderKey(keyProbe("bedrock", "sk-ant-api03-oops"), "sk-ant-api03-oops");
    expect(r).toEqual({
      status: "unchecked",
      detail: "That isn't an Amazon Bedrock API key: they start with ABSK or bedrock-api-key-.",
    });
  });

  it("both real key forms, pasted with spaces too, get the usual note", async () => {
    for (const key of [shortTerm, longTerm, `  ${longTerm}\n`]) {
      const r = await checkProviderKey(keyProbe("bedrock", key), key);
      expect(r.status).toBe("unchecked");
      expect(r.detail).not.toContain("isn't an Amazon Bedrock API key");
    }
  });
});
