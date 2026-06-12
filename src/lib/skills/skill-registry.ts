export type ModeSkillName =
  | "modes/ask-mode"
  | "modes/plan-mode"
  | "modes/build-mode"
  | "modes/debug-mode"
  | "modes/review-mode";

const MODE_MAP: Record<string, ModeSkillName> = {
  ask: "modes/ask-mode",
  plan: "modes/plan-mode",
  build: "modes/build-mode",
  agent: "modes/build-mode",
  debug: "modes/debug-mode",
  review: "modes/review-mode",
};

/** `selectedChatMode` / work-mode string; `agent` maps to build-mode skill. */
export function getSkillNameForMode(mode: string): ModeSkillName {
  return MODE_MAP[mode] ?? "modes/build-mode";
}
