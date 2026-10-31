/**
 * The words every surface shows for a model computer use can't be switched on
 * for. No imports: the renderer, the CLI and ACP all read it.
 */

import type { ComputerUseEligibility } from "@/ipc/ipc_types";

export function ineligibleReason(why: Exclude<ComputerUseEligibility, "eligible">): string {
  if (why === "no-executor")
    return "Computer use is unavailable: the atlarix-computer executor is not included in this build.";
  return why === "no-vision"
    ? "This model can't see images."
    : "This connection can't send screenshots back to the model. An Anthropic-format connection can.";
}

/** The settings key a model's switch is stored under. */
export function computerUseKey(m: { provider?: string; name?: string }): string {
  return `${m.provider ?? ""}/${m.name ?? ""}`;
}
