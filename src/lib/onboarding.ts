/**
 * Onboarding state — first-time guide (Code to Canvas, Blueprint, Ask/Build, AI settings).
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
    body: "Use the Diagram view to see Containers and Beacons. The Blueprint is your living architecture—add containers and connect them.",
    target: "[data-onboarding=blueprint-tab]",
  },
  {
    id: "ask-build",
    title: "Ask vs Build",
    body: "Ask mode is read-only (search, read files). Build mode lets the AI write code and run commands—you approve each change.",
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
    body: "Start building! Open a workspace, describe what you want, and the AI will help you code it.",
    target: null,
  },
] as const;
