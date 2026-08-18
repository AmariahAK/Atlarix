/**
 * `proposals` set addressing.
 *
 * The tool's own not-found error PRINTS the full id and instructs the model to
 * "use the id of the one you mean". A model did exactly that — minus the `prop_`
 * prefix — and was refused anyway, because the only substring pass ran over
 * agent NAMES, never ids. Observed twice in one turn:
 *
 *   No proposal set matches "prop_2aad200b-…-9652-cd8d?"        (truncated id)
 *   No proposal set matches "2aad200b-…-596832c38213_1"         (prefix dropped)
 *
 * The second one is unambiguous and ours to resolve.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearAllProposalSets,
  createProposalSet,
} from "@/lib/agents/subagent-proposals";
import { resolveSet } from "@/lib/tools/proposals";

const CHAT = -60;

function makeSet(agentName: string, taskId = "2aad200b-2cae-458a-965d-596832c38213") {
  return createProposalSet({
    chatId: CHAT,
    taskId,
    agentName,
    workspace: "/tmp/atlarix-proposals-ws",
  });
}

function idOf(r: ReturnType<typeof resolveSet>): string | undefined {
  return "set" in r ? r.set.id : undefined;
}

beforeEach(() => {
  __clearAllProposalSets();
});

describe("resolveSet addressing", () => {
  it("resolves an id missing its prop_ prefix (the reported miss)", () => {
    const id = makeSet("Finish quote boundary edits");
    expect(id.startsWith("prop_")).toBe(true);

    const withoutPrefix = id.slice("prop_".length);
    expect(idOf(resolveSet(CHAT, withoutPrefix))).toBe(id);
  });

  it("still resolves an exact id", () => {
    const id = makeSet("Finish quote boundary edits");
    expect(idOf(resolveSet(CHAT, id))).toBe(id);
  });

  it("resolves by exact agent name and by a distinctive fragment", () => {
    const id = makeSet("Finish quote boundary edits");
    expect(idOf(resolveSet(CHAT, "Finish quote boundary edits"))).toBe(id);
    expect(idOf(resolveSet(CHAT, "quote boundary"))).toBe(id);
  });

  it("reports the awaiting sets when nothing matches at all", () => {
    makeSet("Finish quote boundary edits");
    const r = resolveSet(CHAT, "totally unrelated");
    expect("error" in r && r.error).toContain("No proposal set matches");
  });

  it("says so rather than guessing when an id fragment is ambiguous", () => {
    // Two sets built from the same task id differ only by their trailing
    // sequence number, so a fragment common to both must not silently pick one.
    makeSet("first agent");
    makeSet("second agent");
    const r = resolveSet(CHAT, "2aad200b-2cae-458a-965d-596832c38213");
    expect("error" in r && r.error).toMatch(/matches 2 proposal set ids/);
  });

  it("does not reach across chats", () => {
    const id = makeSet("Finish quote boundary edits");
    expect("error" in resolveSet(-99, id)).toBe(true);
  });
});
