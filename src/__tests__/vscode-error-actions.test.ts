/**
 * The buttons under a failed turn in the editor chat. Your own provider being
 * out of credit is your provider account, so Atlarix's "Add credit" / "Get
 * Pro" / "Use your own key" are the wrong way on: it offers Atlarix Auto (free)
 * and Models & keys (HANDOFF 2026-10-31 item 1d; the text matched /out of
 * credit/ and drew Atlarix's buttons). Atlarix's own credit errors keep theirs.
 */
import { describe, expect, it } from "vitest";
import { errorActions } from "../../packages/vscode/webview/error-actions";
import { byokLimitUserMessage } from "@/shared/texts";
import {
  CORE_EXHAUSTED_MARKER,
  CORE_NEVER_FUNDED_MARKER,
  FREE_LIMIT_MARKER,
  PRO_ALLOWANCE_MARKER,
} from "@/shared/billing_copy";

describe("errorActions", () => {
  it("your own provider out of credit: Atlarix Auto and Models & keys, no checkout", () => {
    for (const reason of ["insufficient credits 402", '{"error":{"type":"insufficient_quota"}}', "Your credit balance is too low"]) {
      const text = byokLimitUserMessage(reason, "OpenRouter")!;
      expect(errorActions(text)).toEqual(["auto", "keys"]);
    }
  });

  it("Atlarix's own credit errors keep their buttons", () => {
    expect(errorActions(`Your Atlarix ${CORE_EXHAUSTED_MARKER}.`)).toEqual(["credit", "pro", "ownKey"]);
    expect(errorActions(`${CORE_NEVER_FUNDED_MARKER}.`)).toEqual(["credit", "pro", "auto"]);
    expect(errorActions(`Your ${PRO_ALLOWANCE_MARKER}.`)).toEqual(["credit", "ownKey"]);
    expect(errorActions(`${FREE_LIMIT_MARKER}.`)).toEqual(["credit", "pro", "ownKey"]);
    expect(errorActions("Insufficient credit on your Atlarix account")).toEqual(["credit", "pro", "ownKey"]);
  });

  it("a rejected key: Models & keys; a rate limit or anything else: nothing", () => {
    expect(errorActions(byokLimitUserMessage("Incorrect API key provided", "OpenAI")!)).toEqual(["keys"]);
    expect(errorActions(byokLimitUserMessage("Rate limit reached", "OpenAI")!)).toEqual([]);
    expect(errorActions('This model failed: "boom". Try again, or switch model.')).toEqual([]);
  });
});
