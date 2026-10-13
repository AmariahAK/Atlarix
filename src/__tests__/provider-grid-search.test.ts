/**
 * The Models & providers search must narrow the WHOLE grid. It used to filter
 * only Core and OpenRouter: the rest came from a stable shuffle of the
 * unfiltered lineup, so typing "deepseek" left every page in place (reported
 * by a user 2026-09-23 — they paged to 17 of 35 to find DeepSeek).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));

import { orderProvidersForPaging } from "@/components/ProviderSettings";
import type { LanguageModelProvider } from "@/ipc/ipc_types";

const p = (id: string, name: string) =>
  ({ id, name, type: "cloud" }) as unknown as LanguageModelProvider;
const ALL = [
  p("compass", "Atlarix Core"),
  p("openrouter", "OpenRouter"),
  p("google", "Google Gemini"),
  p("deepseek", "DeepSeek"),
  p("kuae", "KUAE Cloud Coding Plan"),
];
const shuffled = ALL.slice(2).reverse();

describe("provider grid search", () => {
  it("narrows the shuffled tail to the query", () => {
    const filtered = ALL.filter((x) => x.name.toLowerCase().includes("deepseek"));
    expect(orderProvidersForPaging(filtered, shuffled, "deepseek").map((x) => x.id)).toEqual([
      "deepseek",
    ]);
  });

  it("with no query keeps Core, then OpenRouter, then the stable shuffle", () => {
    expect(orderProvidersForPaging(ALL, shuffled, "").map((x) => x.id)).toEqual([
      "compass",
      "openrouter",
      "kuae",
      "deepseek",
      "google",
    ]);
  });

  it("a query matching nothing shows nothing", () => {
    expect(orderProvidersForPaging([], shuffled, "zzz")).toEqual([]);
  });
});

// QA (app) #31: "5 providers configured", scattered across 37 shuffled pages.
describe("providers you set up", () => {
  it("come right after Core and OpenRouter, the rest still shuffled", () => {
    const setUp = new Set(["google"]);
    expect(
      orderProvidersForPaging(ALL, shuffled, "", (id) => setUp.has(id)).map((x) => x.id),
    ).toEqual(["compass", "openrouter", "google", "kuae", "deepseek"]);
  });
});
