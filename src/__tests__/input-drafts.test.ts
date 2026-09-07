/**
 * Unsent composer text, kept per session and across a restart.
 *
 * The interesting assertions here are the ones about what is NOT stored: a draft
 * keyed by a renderer chat id would be orphaned on the next launch (chat ids are
 * handed out per run by `allocateSessionTransport`), and an empty draft kept as ""
 * would let the store accumulate the residue of every session ever sent from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, loadDraft, saveDraft } from "@/lib/chat/input-drafts";

const KEY = "atlarix:chat-drafts";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
});

describe("chat input drafts", () => {
  it("round-trips a draft for one session", () => {
    saveDraft("sess-a", "half a thought");
    expect(loadDraft("sess-a")).toBe("half a thought");
  });

  it("keeps sessions separate", () => {
    saveDraft("sess-a", "for A");
    saveDraft("sess-b", "for B");
    expect(loadDraft("sess-a")).toBe("for A");
    expect(loadDraft("sess-b")).toBe("for B");
  });

  it("returns empty for a session with no draft", () => {
    expect(loadDraft("never-typed-in")).toBe("");
  });

  it("does nothing without a session id", () => {
    // The window between allocating a chat transport and activating the session.
    // Dropping the draft there is deliberate — see input-drafts.ts.
    saveDraft(null, "typed too early");
    saveDraft(undefined, "same");
    expect(loadDraft(null)).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("treats empty text as a delete, not as a stored empty string", () => {
    saveDraft("sess-a", "something");
    saveDraft("sess-a", "");
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(Object.keys(raw)).not.toContain("sess-a");
  });

  it("treats whitespace-only text as empty", () => {
    saveDraft("sess-a", "   \n\t ");
    expect(loadDraft("sess-a")).toBe("");
  });

  it("clearDraft removes one session without touching the others", () => {
    saveDraft("sess-a", "for A");
    saveDraft("sess-b", "for B");
    clearDraft("sess-a");
    expect(loadDraft("sess-a")).toBe("");
    expect(loadDraft("sess-b")).toBe("for B");
  });

  it("caps a runaway paste so one draft cannot fill the quota", () => {
    saveDraft("sess-a", "x".repeat(500_000));
    expect(loadDraft("sess-a").length).toBe(100_000);
  });

  it("evicts the oldest sessions past the cap", () => {
    for (let i = 0; i < 60; i++) {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, i));
      saveDraft(`sess-${i}`, `draft ${i}`);
    }
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(Object.keys(raw).length).toBe(50);
    // The first ten written are the ten dropped.
    expect(loadDraft("sess-0")).toBe("");
    expect(loadDraft("sess-9")).toBe("");
    expect(loadDraft("sess-59")).toBe("draft 59");
  });

  it("survives unreadable storage rather than throwing at the composer", () => {
    // A locked-down profile, cleared site data, or a browser set to block
    // storage. Losing a draft is a disappointment; throwing while rendering the
    // composer is a broken app.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage);
    expect(() => saveDraft("sess-a", "text")).not.toThrow();
    expect(loadDraft("sess-a")).toBe("");
  });

  it("survives a corrupt store", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadDraft("sess-a")).toBe("");
    expect(() => saveDraft("sess-a", "text")).not.toThrow();
  });

  it("ignores a store that parses to the wrong shape", () => {
    localStorage.setItem(KEY, "[1,2,3]");
    expect(loadDraft("sess-a")).toBe("");
  });
});
