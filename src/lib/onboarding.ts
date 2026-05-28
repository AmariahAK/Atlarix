/**
 * Onboarding state — first-time guide (workspace-first UI).
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
    body: "Your private sovereign AI IDE — open a folder to start, with saved sessions and workspace-scoped tools.",
    target: null as string | null,
  },
  {
    id: "open-folder",
    title: "Open a workspace",
    body: "From the welcome screen, use Open folder or Clone repo — or pick a recent workspace.",
    target: "[data-onboarding=welcome-open-folder]",
  },
  {
    id: "byok",
    title: "Models & Atlarix Core",
    body: "Atlarix Core works without an API key. Open Settings to add BYOK providers (OpenAI, Anthropic, Gemini, Ollama, and more).",
    target: "[data-onboarding=settings-link]",
  },
  {
    id: "sessions",
    title: "Sessions in the sidebar",
    body: "Each workspace keeps saved chat sessions. Use + for a new ephemeral chat; switch sessions without stopping background work.",
    target: "[data-onboarding=workspace-sessions]",
  },
  {
    id: "right-panel",
    title: "Right panel",
    body: "Preview, Code (file tree + editor), Activity, Terminal, and Errors — resize with the grip between chat and the panel.",
    target: "[data-onboarding=panel-resize-grip]",
  },
  {
    id: "done",
    title: "You're set",
    body: "Explore work modes (Ask, Plan, Build, Debug, Review), sub-agents, and workspace MCP/skills under Settings.",
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
