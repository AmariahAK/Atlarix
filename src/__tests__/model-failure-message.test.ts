import { describe, expect, it } from "vitest";
import { CORE_TIER_NEWER_BUILD, modelFailureUserMessage } from "@/shared/texts";

describe("a model's failure, said plainly (QA)", () => {
  it("an unknown model id: no raw JSON, the likely fix", () => {
    const m = modelFailureUserMessage('Not Found\n\nDetails: {"error":{"message":"model \'nope:9b\' not found","type":"api_error"}}');
    expect(m).toBe(`The provider doesn't have that model. Check the model's id, or switch model. (It said: "model 'nope:9b' not found")`);
  });
  it("a wrong path: one line, points at the base URL", () => {
    const m = modelFailureUserMessage("Not Found\n\nDetails: 404 page not found");
    expect(m).not.toContain("\n");
    expect(m).toContain("base URL");
    expect(m).not.toContain("chat settings");
  });
  it("nothing answering: says so", () => {
    expect(modelFailureUserMessage("Cannot connect to API: Unable to connect")).toContain("Couldn't reach the provider");
  });
});

describe("a Core model from a newer Atlarix", () => {
  it("is said as it is, without \"try again\", which can't help", () => {
    expect(modelFailureUserMessage(`Error: ${CORE_TIER_NEWER_BUILD}`)).toBe(CORE_TIER_NEWER_BUILD);
  });
});
