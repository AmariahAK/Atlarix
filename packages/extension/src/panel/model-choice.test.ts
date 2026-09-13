/**
 * The picker.
 *
 * THE FIRST TEST IS THE REASON THIS FILE EXISTS. Sending the tier instead of
 * the wire id type-checks, lints, builds, and renders a dropdown that looks
 * exactly right — and then every message comes back 400 `model_not_permitted`,
 * because the proxy's `resolveModel` keys on the wire id.
 */

import { describe, expect, it } from "vitest";
import type { CoreModel } from "../core/client";
import {
  chooseModel,
  optionsFor,
  shortModelName,
  tierLabel,
} from "./model-choice";

/** The live proxy's actual answer, 2026-09-13. */
const LINEUP: Pick<CoreModel, "id" | "tier">[] = [
  { id: "z-ai/glm-5.3", tier: "core-1" },
  { id: "openai/gpt-5.6-terra", tier: "core-2" },
  { id: "openai/gpt-6-astra", tier: "core-3" },
];

describe("the value sent to the proxy", () => {
  it("is the WIRE id, never the tier", () => {
    const values = optionsFor(LINEUP).map((o) => o.value);
    expect(values).toEqual([
      "z-ai/glm-5.3",
      "openai/gpt-5.6-terra",
      "openai/gpt-6-astra",
    ]);
    for (const value of values) expect(value).not.toMatch(/^core-\d+$/);
  });

  it("shows the tier AND the model, because neither alone is enough", () => {
    // "Core 2" says nothing about what it is; "gpt-5.6-terra" says nothing
    // about what it costs.
    expect(optionsFor(LINEUP).map((o) => o.label)).toEqual([
      "Core 1 · glm-5.3",
      "Core 2 · gpt-5.6-terra",
      "Core 3 · gpt-6-astra",
    ]);
  });

  it("keeps the proxy's order rather than forming a second opinion", () => {
    const reversed = [...LINEUP].reverse();
    expect(optionsFor(reversed)[0].value).toBe("openai/gpt-6-astra");
  });

  it("drops an entry with no id instead of offering a blank model", () => {
    expect(optionsFor([{ id: "", tier: "core-9" }])).toEqual([]);
  });

  it("still labels a model the proxy gave no tier for", () => {
    expect(optionsFor([{ id: "vendor/x-1", tier: "" }])[0].label).toBe("x-1");
  });
});

describe("choosing", () => {
  it("keeps the user's last choice", () => {
    expect(chooseModel(optionsFor(LINEUP), "openai/gpt-6-astra")).toBe(
      "openai/gpt-6-astra",
    );
  });

  it("falls back to the first when the stored one is no longer offered", () => {
    // The lineup is configuration and has changed before. A stored id for a
    // retired model would 503 on every send.
    expect(chooseModel(optionsFor(LINEUP), "moonshotai/kimi-k2.7-code")).toBe(
      "z-ai/glm-5.3",
    );
  });

  it("returns null rather than inventing an id when there are no options", () => {
    // A hardcoded fallback would produce `model_not_permitted` at exactly the
    // moment the proxy was already unreachable — two failures reported as one
    // confusing message.
    expect(chooseModel([], "z-ai/glm-5.3")).toBeNull();
    expect(chooseModel([], null)).toBeNull();
  });
});

describe("labels", () => {
  it("shows an unrecognised tier as it came, rather than hiding it", () => {
    expect(tierLabel("core-1")).toBe("Core 1");
    expect(tierLabel("preview")).toBe("preview");
  });

  it("strips the vendor prefix, which is noise in a 320px panel", () => {
    expect(shortModelName("z-ai/glm-5.3")).toBe("glm-5.3");
    expect(shortModelName("bare-id")).toBe("bare-id");
  });
});
