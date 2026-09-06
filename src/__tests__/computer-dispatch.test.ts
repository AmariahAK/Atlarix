/**
 * The dispatch allowlist, and its agreement with the binary we actually ship.
 *
 * `computer_call` can reach any driver tool, so this table is the boundary. Two
 * classes of mistake it has to catch:
 *
 *  1. **Drift from the driver.** A pinned upgrade that adds a tool must not
 *     silently widen what the model can do, and one that removes a tool must not
 *     leave us advertising a name that no longer exists. So the sets are checked
 *     against `list-tools` on the real binary, not against a copy of the list.
 *  2. **A spec that forgets its target.** Every guard in this feature hangs off
 *     `resolveTargetApp`, and it is reached only for the fields a spec declares in
 *     `appTarget`. A tool whose schema takes `pid` but whose spec omits it is a
 *     silent hole — the tool works, and Atlarix, Terminal and 1Password are all
 *     reachable through it. That case is asserted against the driver's own schemas.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  DISPATCH,
  DENIED,
  HOST_ONLY,
  HOST_OWNED_FIELDS,
  MODEL_FACING_TOOLS,
  classifyTool,
} from "@/lib/computer/dispatch";
import { usesDesktopScope, DESKTOP_SCOPE_REFUSAL } from "@/lib/computer/dispatch";

const DRIVER = path.join(process.cwd(), "native", ".dist", "cua-driver");
/**
 * The `quality` CI job type-checks and tests but never BUILDS the driver (only the
 * per-platform build jobs do), so the binary is legitimately absent there. Skipping
 * is right; skipping SILENTLY is not, so the skip is announced.
 */
const haveDriver = existsSync(DRIVER);
if (!haveDriver) {
  console.log(
    "[computer-dispatch] native/.dist/cua-driver absent — live driver agreement checks skipped",
  );
}

function driverToolNames(): string[] {
  const out = execFileSync(DRIVER, ["list-tools"], { encoding: "utf8", timeout: 30_000 });
  return out
    .split("\n")
    .filter((l) => /^\S+:/.test(l))
    .map((l) => l.split(":")[0]!.trim());
}

function schemaProps(tool: string): string[] {
  const out = execFileSync(DRIVER, ["describe", tool], { encoding: "utf8", timeout: 20_000 });
  const start = out.indexOf("input_schema:");
  if (start < 0) return [];
  const brace = out.indexOf("{", start);
  if (brace < 0) return [];
  try {
    const parsed = JSON.parse(out.slice(brace)) as { properties?: Record<string, unknown> };
    return Object.keys(parsed.properties ?? {});
  } catch {
    return [];
  }
}

describe("dispatch table", () => {
  it("classifies every tool exactly once", () => {
    const all = [...Object.keys(DISPATCH), ...HOST_ONLY, ...Object.keys(DENIED)];
    // A name in two buckets is ambiguous: which wins would depend on check order.
    expect(new Set(all).size).toBe(all.length);
  });

  it("exposes 34 model-facing tools, and the enum list matches", () => {
    expect(Object.keys(DISPATCH)).toHaveLength(34);
    expect(MODEL_FACING_TOOLS).toHaveLength(34);
    expect([...MODEL_FACING_TOOLS].sort()).toEqual(MODEL_FACING_TOOLS);
  });

  it("keeps `session` host-owned", () => {
    // It appears on nearly every driver tool. Sessions are per-turn host lifecycle
    // (they are what mints the driver's cursor), so a model-supplied id could
    // address another turn's session or a dead one.
    expect(HOST_OWNED_FIELDS).toContain("session");
  });
});

describe("classifyTool", () => {
  it("allows a model-facing tool and hands back its spec", () => {
    const v = classifyTool("get_window_state");
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.spec.appTarget).toContain("pid");
  });

  it("refuses the denied five with a reason and no retry", () => {
    for (const name of Object.keys(DENIED)) {
      const v = classifyTool(name);
      expect(v.allowed, `${name} must be refused`).toBe(false);
      if (v.allowed) continue;
      // Category 3: refused by policy, permanently. An agent told "failed" retries.
      expect(v.reason).toMatch(/Do not retry/i);
    }
  });

  it("refuses host-driven lifecycle tools as Atlarix's job", () => {
    for (const name of HOST_ONLY) {
      const v = classifyTool(name);
      expect(v.allowed, `${name} must not be model-callable`).toBe(false);
      if (v.allowed) continue;
      expect(v.reason).toMatch(/Atlarix manages it/i);
    }
  });

  it("suggests near misses instead of making the model re-read the list", () => {
    const v = classifyTool("browser_clik");
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toMatch(/browser_click/);
  });

  it("rejects an empty or missing name without throwing", () => {
    for (const bad of ["", "   ", undefined as unknown as string]) {
      const v = classifyTool(bad);
      expect(v.allowed).toBe(false);
    }
  });

  it("does not treat a denied name as merely unknown", () => {
    // The distinction matters: "unknown" invites a retry with a corrected name,
    // "denied" must not.
    const v = classifyTool("replay_trajectory");
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).not.toMatch(/No dispatchable tool named/);
  });
});

describe.skipIf(!haveDriver)("agreement with the shipped driver", () => {
  it("accounts for every tool the driver offers, and invents none", () => {
    const real = new Set(driverToolNames());
    const ours = new Set([
      ...Object.keys(DISPATCH),
      ...HOST_ONLY,
      ...Object.keys(DENIED),
    ]);
    const missing = [...real].filter((t) => !ours.has(t));
    const phantom = [...ours].filter((t) => !real.has(t));

    // A pinned driver upgrade that ADDS a tool lands here rather than silently
    // widening the model's reach; one that REMOVES a tool stops us advertising a
    // name that no longer resolves.
    expect(missing, "driver tools with no bucket — decide where each belongs").toEqual([]);
    expect(phantom, "table entries the driver does not have").toEqual([]);
  });

  it("declares an appTarget for every tool whose schema takes one", () => {
    // THE SILENT HOLE THIS CATCHES: a spec that omits `pid` still works, and
    // Atlarix, Terminal and 1Password are all reachable through that tool, because
    // resolveTargetApp is only consulted for declared fields.
    const TARGET_FIELDS = ["pid", "bundle_id"];
    const offenders: string[] = [];

    for (const [tool, spec] of Object.entries(DISPATCH)) {
      const props = schemaProps(tool);
      for (const field of TARGET_FIELDS) {
        if (!props.includes(field)) continue;
        if (!spec.appTarget?.includes(field)) offenders.push(`${tool}.${field}`);
      }
    }

    expect(offenders, "these reach the driver without passing resolveTargetApp").toEqual([]);
  });

  it("declares driverConfirm wherever the driver owns a `confirm` of its own", () => {
    /**
     * A NAME COLLISION, caught as a class rather than as one instance.
     *
     * Atlarix's two-step gate for the irreversible tools reads `input.confirm` and
     * strips it before dispatch, because it is not a driver field. `install_ffmpeg`
     * has a `confirm` of its own — "pass `confirm: true` to actually run it" — and
     * stripping that one made the install step permanently unreachable: every call
     * reported the command and never ran it, which looks exactly like the tool
     * working. If a driver upgrade gives another tool a `confirm`, it lands here.
     */
    const offenders: string[] = [];
    for (const [tool, spec] of Object.entries(DISPATCH)) {
      if (!schemaProps(tool).includes("confirm")) continue;
      if (!spec.driverConfirm) offenders.push(tool);
    }
    expect(offenders, "Atlarix would strip these tools' own confirm flag").toEqual([]);
  });

  it("declares typesInto wherever the driver accepts text to type", () => {
    // Same shape of hole for guardTypeTarget: text reaching a secure field.
    const offenders: string[] = [];
    for (const [tool, spec] of Object.entries(DISPATCH)) {
      const props = schemaProps(tool);
      for (const field of ["text", "value"]) {
        if (!props.includes(field)) continue;
        if (!spec.typesInto?.includes(field)) offenders.push(`${tool}.${field}`);
      }
    }
    expect(offenders, "these could type into a password field unchecked").toEqual([]);
  });
});

/**
 * TOP LEVEL ON PURPOSE. These four assert PURE functions and need no binary, but the
 * first version of this file nested them inside the `describe.skipIf(!haveDriver)`
 * block above — so on CI's `quality` job, which type-checks and tests but never
 * BUILDS the driver, the most load-bearing security tests in the file skipped
 * silently while the run stayed green. `skipIf` is inherited by every nested
 * describe, and a skipped test looks exactly like a passing one in a summary line.
 */
describe("screen-absolute escape hatches", () => {
  /**
   * THE BYPASS THIS EXISTS FOR. The first draft of the table declared which FIELDS
   * name a target and stopped there — but the driver documents a form with NO
   * target at all: "Pass `desktop` when sending x,y with NO pid/window_id — the
   * coordinates are then true screen pixels." A call in that form reaches no
   * `resolveTargetApp`, so every refusal in guards.ts is skipped, and the frontmost
   * application when Atlarix shows an approval card is Atlarix.
   */
  it("detects scope:\"desktop\"", () => {
    expect(usesDesktopScope({ scope: "desktop", x: 10, y: 10 })).toBe(true);
  });

  it("detects the nested target.kind:\"desktop\" form too", () => {
    // Two independent spellings; catching one and missing the other is the same
    // as catching neither.
    expect(usesDesktopScope({ target: { kind: "desktop", display_id: "primary" } })).toBe(true);
  });

  it("leaves ordinary window-scoped input alone", () => {
    expect(usesDesktopScope({ scope: "window", pid: 42 })).toBe(false);
    expect(usesDesktopScope({ target: { kind: "window", pid: 42 } })).toBe(false);
    expect(usesDesktopScope({})).toBe(false);
    expect(usesDesktopScope(undefined)).toBe(false);
    expect(usesDesktopScope("nonsense")).toBe(false);
  });

  it("refuses permanently, and says why nothing can check it", () => {
    // Category 3 wording. Retrying cannot help: there is no target to name.
    expect(DESKTOP_SCOPE_REFUSAL).toMatch(/will not do this/i);
    expect(DESKTOP_SCOPE_REFUSAL).toMatch(/Do not retry/i);
    expect(DESKTOP_SCOPE_REFUSAL).toMatch(/Atlarix's own windows/i);
  });
});

describe.skipIf(!haveDriver)("escape hatches vs the real schemas", () => {
  it("covers every model-facing tool that actually admits a desktop scope", () => {
    // Derived from the binary rather than a hand list, so a driver upgrade that
    // adds `scope` to another tool cannot quietly open a second door.
    const admits = Object.keys(DISPATCH).filter((t) => {
      const props = schemaProps(t);
      return props.includes("scope") || props.includes("target");
    });
    expect(admits.length).toBeGreaterThan(0);
    for (const tool of admits) {
      expect(usesDesktopScope({ scope: "desktop" }), `${tool} must be covered`).toBe(true);
    }
  });
});
