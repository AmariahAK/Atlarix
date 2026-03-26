/**
 * Onboarding state — first-time guide (Code to Canvas, Blueprint, work modes, AI settings).
 * Stored in localStorage so "Restart guide" in Settings can reset it.
 */

const STORAGE_KEY = "atlarix_onboarding_done";

export function isOnboardingDone(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return true;
  }
}

export function setOnboardingDone(done: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (done) {
      localStorage.setItem(STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export function resetOnboarding(): void {
  setOnboardingDone(false);
}

export const ONBOARDING_STEPS = [
  {
    id: "welcome",
    title: "Welcome to Atlarix",
    body: "Code to Canvas, Canvas to Code. Design your architecture visually and generate code, or start from code and see it on the canvas.",
    target: null as string | null,
  },
  {
    id: "blueprint",
    title: "Blueprint tab",
    body: "Use the Diagram view to inspect architecture and Blueprint context. v5.0 discovery flow is: high-level map, explore folders, then targeted blueprint slices.",
    target: "[data-onboarding=blueprint-tab]",
  },
  {
    id: "ask-build",
    title: "Work modes",
    body: "Use Ask, Plan, Build, Debug, or Review (or Auto). Ask is read-only; Plan writes `.atlarix/ATLARIX_PLAN.md`; Build executes approved file/command changes.",
    target: "[data-onboarding=ask-build-toggle]",
  },
  {
    id: "ai-settings",
    title: "Add your API key",
    body: "Go to Settings → AI Settings to add your model provider API key so the AI can respond. You can use OpenRouter, OpenAI, or others.",
    target: "[data-onboarding=settings-link]",
  },
  {
    id: "done",
    title: "You're all set",
    body: "Start building. Ask for a plan to get a collapsible Plan card and a saved `.atlarix/ATLARIX_PLAN.md`, then switch to Build to execute tasks.",
    target: null,
  },
] as const;
