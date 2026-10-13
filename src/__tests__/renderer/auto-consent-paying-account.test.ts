/**
 * QA (app) #42: a Pro account picking Atlarix Auto was asked to agree to free
 * Auto's sharing with OpenAI. The picker's balance was still loading
 * ("unknown"), and unknown asked. The picker now asks main first.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fetchAccountKind } from "@/hooks/useAccountKind";

function stub(result: unknown) {
  (window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { invoke: async () => result },
  };
}
afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("the account kind at the moment Auto is picked", () => {
  it("is Pro for an account with an allowance", async () => {
    stub({ ok: true, balanceCents: 1900, grantedTotalCents: 1900 });
    expect(await fetchAccountKind()).toBe("pro");
  });
  it("is free with nothing to spend", async () => {
    stub({ ok: true, balanceCents: 0, grantedTotalCents: 0 });
    expect(await fetchAccountKind()).toBe("free");
  });
  it("stays unknown when it can't be told", async () => {
    stub({ ok: false });
    expect(await fetchAccountKind()).toBe("unknown");
  });
});
