import { describe, expect, it } from "vitest";
import { normalizeRouteHttpMethod, routePatternSpecs } from "../lib/blueprint/rte/ast-grep/rules/routes";
import { Lang } from "@ast-grep/napi";

describe("route pattern helpers", () => {
  it("normalizes Next.js HTTP export names", () => {
    expect(normalizeRouteHttpMethod("GET")).toBe("GET");
    expect(normalizeRouteHttpMethod("post")).toBe("POST");
    expect(normalizeRouteHttpMethod("handler")).toBeNull();
  });

  it("includes Express and Next route specs", () => {
    const specs = routePatternSpecs(Lang.TypeScript);
    expect(specs.some((s) => s.httpMethod === "GET" && s.capturePath)).toBe(true);
    expect(specs.some((s) => s.captureMethod)).toBe(true);
  });
});
