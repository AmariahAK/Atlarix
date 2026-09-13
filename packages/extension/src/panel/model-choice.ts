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
}

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
export function optionsFor(models: CoreModel[]): ModelOption[] {
  return models
    .filter((m) => m.id)
    .map((m) => ({
      value: m.id,
      label: m.tier
        ? `${tierLabel(m.tier)} · ${shortModelName(m.id)}`
        : shortModelName(m.id),
    }));
}

/**
 * Which option to select: the one the user last chose, else the first.
 *
 * Returns null when there is nothing to choose — the caller must then refuse to
 * send rather than guess an id. A GUESS IS THE WRONG MOVE HERE even though it
 * looks harmless: the lineup is configuration, it has changed before, and a
 * hardcoded fallback would produce `model_not_permitted` at exactly the moment
 * the proxy was already unreachable — two failures reported as one confusing
 * message. `docs/TODO.md` records the same rule for the README and the
 * launchpad: do not restate a config's contents.
 */
export function chooseModel(
  options: ModelOption[],
  stored: string | null,
): string | null {
  if (options.length === 0) return null;
  if (stored && options.some((o) => o.value === stored)) return stored;
  return options[0].value;
}
