import { describe, expect, it } from "bun:test";
import { providerDisplayName } from "../src/ipc/shared/language_model_helpers";

describe("failure messages name a provider as people know it (app QA #26)", () => {
  it("never shows the custom:: id, even before the provider list is read", () => {
    expect(providerDisplayName("custom::qa-ai49-badkey")).toBe("qa-ai49-badkey");
    expect(providerDisplayName(undefined)).toBeUndefined();
  });
});
