/**
 * Onboarding state — first-time guide (v5.1: sign in → Compass → BYOK in Settings).
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
    body: "Your private sovereign AI IDE — Blueprint memory, work modes, and Compass built in.",
    target: null as string | null,
  },
  {
    id: "compass-chat",
    title: "Start with Compass",
    body: "Compass works immediately — no API key. Type in the chat to get started.",
    target: "[data-onboarding=home-chat-input]",
  },
  {
    id: "byok",
    title: "Bring your own models",
    body: "Open Settings to add API keys for OpenAI, Anthropic, Gemini, Ollama, and more whenever you want.",
    target: "[data-onboarding=settings-link]",
  },
  {
    id: "done",
    title: "You're set",
    body: "Explore workspaces, Blueprint, and work modes (Ask, Plan, Build, Debug, Review) when you're ready.",
    target: null,
  },
] as const;
