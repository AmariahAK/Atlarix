import { describe, expect, it } from "vitest";
import { getAppVersion } from "../lib/app-version";

describe("getAppVersion", () => {
  it("returns a non-empty version string", () => {
    const v = getAppVersion();
    expect(v.length).toBeGreaterThan(0);
    expect(v).not.toBe("unknown");
  });
});
