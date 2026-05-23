/**
 * Onboarding state — first-time guide (v5.1: sign in → Compass → BYOK in Settings).
 * Stored in localStorage so "Restart guide" in Settings can reset it.
 */

import type { OnboardingStep } from "@/atoms/viewAtoms";

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
    body: "Your private sovereign AI IDE — project memory, work modes, and Compass built in.",
    target: null as string | null,
  },
  {
    id: "compass-chat",
    title: "Start with Compass",
    body: "Atlarix Core works immediately — no API key. Type in the chat to get started.",
    target: "[data-onboarding=home-chat-input]",
  },
  {
    id: "byok",
    title: "Bring your own models",
    body: "Open Settings to add API keys for OpenAI, Anthropic, Gemini, Ollama, and more whenever you want.",
    target: "[data-onboarding=settings-link]",
  },
  // Fix: Finding 2 — continuity + right panel (wired via onboardingStepAtom 4–5)
  {
    id: "chat-continuity",
    title: "How chat memory works",
    body: "There is no long-lived chat history. Use your .atlarix folder (project memory, snapshots, ATLARIX_PLAN.md) so context carries across sessions.",
    target: "[data-onboarding=chat-continuity]",
  },
  {
    id: "right-panel",
    title: "Right panel",
    body: "Drag the grip between chat and the preview panel to resize. Use the tabs for Preview, Code, Terminal, and more.",
    target: "[data-onboarding=panel-resize-grip]",
  },
  {
    id: "done",
    title: "You're set",
    body: "Explore workspaces, diagrams, and work modes (Ask, Plan, Build, Debug, Review). On Workforce, configure team MCP servers and credentials in Settings; the app will ask for per-chat scope when using integration tools.",
    target: null,
  },
] as const;

const ONBOARDING_ACTIVE_STEP_KEY = "atlarix_onboarding_active_step";

/** Persist in-flight onboarding step so reload mid-flow resumes at 4/5. */
export function persistOnboardingStep(step: OnboardingStep): void {
  if (typeof window === "undefined") return;
  try {
    if (step === null) {
      localStorage.removeItem(ONBOARDING_ACTIVE_STEP_KEY);
    } else {
      localStorage.setItem(ONBOARDING_ACTIVE_STEP_KEY, String(step));
    }
  } catch {
    // ignore
  }
}

export function readPersistedOnboardingStep(): OnboardingStep | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(ONBOARDING_ACTIVE_STEP_KEY);
    if (v === "1" || v === "2" || v === "3" || v === "4" || v === "5") {
      return Number(v) as OnboardingStep;
    }
  } catch {
    // ignore
  }
  return null;
}
