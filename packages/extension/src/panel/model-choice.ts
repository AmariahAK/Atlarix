/**
 * Which model the picker offers, and which one it sends.
 *
 * THE WHOLE REASON THIS IS A MODULE. The value sent to the proxy must be the
 * **wire id** — `z-ai/glm-5.3` — and NOT the tier — `core-1`. The proxy's
 * `resolveModel` searches `coreSnapshot.models` for a key whose VALUE equals
 * what was sent, so a tier name resolves to nothing and comes back
 * `model_not_permitted` with a 400. The desktop's Core client says the same
 * thing in a comment: "The WIRE id stays `vendor/model`: the proxy's allowlist
 * keys on it."
 *
 * That is invisible in every way that matters until a user sends their first
 * message. `GET /v1/models` returns BOTH fields, the tier is the more natural
 * thing to show a human, and picking it for the value is a one-word mistake
 * that type-checks, lints, builds and renders a perfectly correct-looking
 * dropdown. So the logic lives here, where a test can hold it.
 *
 * THE TIER IS STILL WHAT THE USER IS CHOOSING, so it stays in the label — with
 * the real model name beside it, because "Core 2" alone says nothing about what
 * it is and `gpt-5.6-terra` alone says nothing about what it costs.
 */

import type { CoreModel } from "../core/client";

export interface ModelOption {
  /** Sent to the proxy. The WIRE id, never the tier. */
  value: string;
  /** Shown in the picker. */
  label: string;
  /**
   * The tier this option came from, carried through so `chooseModel` can prefer
   * one. It is NOT sent anywhere — `value` is still the only thing the proxy
   * sees. Before this existed `optionsFor` dropped the tier on the way out, so
   * the default could only ever be positional.
   */
  tier: string;
}

/**
 * The PAID tier the panel opens on when the user has not chosen and the proxy
 * does not offer Atlarix Auto (Auto is preferred above all — see chooseModel).
 *
 * A TIER, deliberately, and never a wire id. The lineup is configuration that
 * has changed before — `core-3` was `deepseek-v4-pro` and is `gpt-6-astra`
 * today — so naming the model here would pin a default to whatever was true the
 * day it was written, and restating a config's contents is the mistake recorded
 * against the README and the launchpad in `docs/TODO.md`.
 *
 * WHY core-3 AND NOT core-1. core-1 is text-only (GLM 5.3 at the time of
 * writing), so every user who dropped in a screenshot met a refusal on their
 * first interesting turn — `attachments.ts` was working exactly as designed and
 * the DEFAULT was what made the refusal the common path. core-3 is the
 * multimodal end of the lineup. This costs more per turn than core-1, which was
 * weighed and accepted: this is the surface a non-developer meets first.
 */
const PAID_PREFERRED_TIER = "core-3";

/**
 * The proxy's tier for Atlarix Auto — ONE option for everyone: free (shared
 * with OpenAI, after a one-time OK) for an account with no credit, routed per
 * request and billed for one with Pro or credit. The default since 2026-09-23.
 */
export const AUTO_TIER = "auto";

/** `core-1` → `Core 1`. Anything unrecognised is shown as it came. */
export function tierLabel(tier: string): string {
  const match = /^core-(\d+)$/.exec(tier);
  return match ? `Core ${match[1]}` : tier;
}

/** `z-ai/glm-5.3` → `glm-5.3`. The vendor prefix is noise in a 320px panel. */
export function shortModelName(id: string): string {
  return id.split("/").pop() || id;
}

/**
 * The picker's options, in the order the proxy listed them.
 *
 * The proxy's order is the lineup's order (core-1 first), and re-sorting here
 * would mean a second opinion about which model is the default.
 */
export function optionsFor(
  // `Pick`, not `CoreModel`: the picker reads the id and the tier and nothing
  // else. Narrowing it here says so, and keeps a test fixture from having to
  // carry a context window to exercise a label.
  models: Pick<CoreModel, "id" | "tier">[],
): ModelOption[] {
  return models
    .filter((m) => m.id)
    .map((m) => ({
      value: m.id,
      // Auto names no single model — the proxy picks per turn — so it is
      // labelled for what it is, not as a tier plus a model id.
      label:
        m.tier === AUTO_TIER
          ? "Atlarix Auto"
          : m.tier
            ? `${tierLabel(m.tier)} · ${shortModelName(m.id)}`
            : shortModelName(m.id),
      // May be "" — the proxy has served a lineup without tiers before, and an
      // option with no tier simply never matches a preferred tier.
      tier: m.tier ?? "",
    }));
}

/**
 * Which option to select: the one the user last chose, else the preferred tier,
 * else the first.
 *
 * Returns null when there is nothing to choose — the caller must then refuse to
 * send rather than guess an id. A GUESS IS THE WRONG MOVE HERE even though it
 * looks harmless: the lineup is configuration, it has changed before, and a
 * hardcoded fallback would produce `model_not_permitted` at exactly the moment
 * the proxy was already unreachable — two failures reported as one confusing
 * message. `docs/TODO.md` records the same rule for the README and the
 * launchpad: do not restate a config's contents.
 *
 * THE FINAL FALLBACK IS STILL `options[0]`, NOT A WIRE ID. That is what keeps
 * the rule above intact: a lineup that has no `core-3` is a lineup we still
 * serve from, using whatever the proxy listed first. The preference is a
 * lookup into what the proxy sent, never an assertion about what it should
 * have sent.
 *
 * A STORED CHOICE ALWAYS WINS. Moving the default must not silently move a
 * model out from under someone who picked one — and every user who has ever
 * touched the picker has a stored value.
 *
 * This is the ONLY place the default is decided; `sidepanel.ts` calls it once
 * and nothing else recomputes it. Checked before writing this, because this
 * project has previously "moved a default" in a function with no production
 * callers and shipped a change that did nothing.
 */
export function chooseModel(
  options: ModelOption[],
  stored: string | null,
): string | null {
  if (options.length === 0) return null;
  if (stored && options.some((o) => o.value === stored)) return stored;
  // Atlarix Auto first: it works for every account, and the free path asks for
  // its one-time OK before anything is shared. Then the paid preference, then
  // whatever the proxy listed first.
  const auto = options.find((o) => o.tier === AUTO_TIER);
  if (auto) return auto.value;
  const preferred = options.find((o) => o.tier === PAID_PREFERRED_TIER);
  if (preferred) return preferred.value;
  return options[0]?.value ?? null;
}
