import { Lang } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { importPatterns, IMPORT_CAPTURE } from "../lib/blueprint/rte/ast-grep/rules/imports";
import { callPatterns, CALLEE_CAPTURE } from "../lib/blueprint/rte/ast-grep/rules/calls";
import { routePatternSpecs } from "../lib/blueprint/rte/ast-grep/rules/routes";
import { LANG_GO, LANG_PYTHON } from "../lib/blueprint/rte/ast-grep/lang-map";
import { hasAstGrep } from "./helpers/native-tools";

describe.skipIf(!hasAstGrep())("ast-grep rule configs", () => {
  it("exports import, call, and route pattern configs", () => {
    expect(importPatterns(Lang.TypeScript).length).toBeGreaterThan(0);
    expect(callPatterns(Lang.TypeScript).length).toBeGreaterThan(0);
    expect(routePatternSpecs(Lang.TypeScript).length).toBeGreaterThan(0);
    expect(importPatterns(LANG_PYTHON).length).toBeGreaterThan(0);
    expect(importPatterns(LANG_GO).length).toBeGreaterThan(0);
    expect(callPatterns(LANG_PYTHON).length).toBeGreaterThan(0);
    expect(IMPORT_CAPTURE).toBe("PATH");
    expect(CALLEE_CAPTURE).toBe("CALLEE");
  });
});
