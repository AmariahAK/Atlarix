/**
 * First-run setup wizard (v10)
 * ============================
 * One skippable modal for new users: welcome → providers/keys → default
 * model → open a workspace. Replaces the legacy 5-step localStorage
 * onboarding overlay; the Shepherd in-app tour still runs afterwards.
 *
 * State lives in settings (`firstRunWizardCompleted`) so it survives
 * reinstalls. Existing users are migrated silently: any legacy completion
 * marker (localStorage flag or `onboarding:get-completed`) marks the wizard
 * done without showing it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/useSettings";
import { openWorkspaceFromDirectoryPicker } from "@/lib/open-workspace-session";
import { useLoadApps } from "@/hooks/useLoadApps";
import { showError } from "@/lib/toast";
import {
  Bot,
  Check,
  Compass,
  FolderOpen,
  KeyRound,
  Rocket,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";

const TOTAL_STEPS = 4;

/** Known cloud providers worth surfacing in the key-detection list. */
const KNOWN_PROVIDERS: Array<{ id: string; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "groq", label: "Groq" },
  { id: "mistral", label: "Mistral" },
  { id: "xai", label: "xAI" },
  { id: "together", label: "Together AI" },
];

function useLegacyOnboardingMarker(): () => Promise<boolean> {
  return useCallback(async () => {
    try {
      if (localStorage.getItem("atlarix_onboarding_done") === "true") return true;
      if (localStorage.getItem("atlarix.onboarding_skipped")) return true;
    } catch {
      /* ignore */
    }
    try {
      const ipc = window.electron?.ipcRenderer;
      if (ipc?.invoke) {
        const result = (await ipc.invoke("onboarding:get-completed")) as {
          completed?: boolean;
        };
        if (result?.completed) return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }, []);
}

export function FirstRunWizard() {
  const { settings, updateSettings } = useSettings();
  const navigate = useNavigate();
  const { refreshApps } = useLoadApps();
  const checkLegacyMarker = useLegacyOnboardingMarker();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [decided, setDecided] = useState(false);

  // "Restart guide" in Settings sets the flag back to false — re-evaluate.
  useEffect(() => {
    if (settings?.firstRunWizardCompleted === false && decided && !open) {
      setStep(0);
      setDecided(false);
    }
  }, [settings?.firstRunWizardCompleted, decided, open]);

  // Gate: show only for genuinely new users; migrate legacy completion silently.
  useEffect(() => {
    if (decided || !settings) return;
    let cancelled = false;
    void (async () => {
      if (settings.firstRunWizardCompleted) {
        setDecided(true);
        return;
      }
      const legacyDone = await checkLegacyMarker();
      if (cancelled) return;
      setDecided(true);
      if (legacyDone) {
        void updateSettings({ firstRunWizardCompleted: true });
        return;
      }
      try {
        const ipc = window.electron?.ipcRenderer;
        const userResult = ipc?.invoke
          ? ((await ipc.invoke("auth:get-current-user")) as {
              user?: { id?: string };
            })
          : null;
        if (!cancelled) setSignedIn(Boolean(userResult?.user?.id));
      } catch {
        if (!cancelled) setSignedIn(false);
      }
      if (!cancelled) setOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [settings, decided, checkLegacyMarker, updateSettings]);

  const detectedProviders = useMemo(() => {
    const ps = settings?.providerSettings ?? {};
    return KNOWN_PROVIDERS.filter((p) => {
      const entry = (ps as Record<string, { apiKey?: { value?: string } }>)[p.id];
      return Boolean(entry?.apiKey?.value);
    });
  }, [settings?.providerSettings]);

  const selectedModel = settings?.selectedModel;

  const finish = useCallback(
    async (navigateTo?: string, navigateSearch?: Record<string, string>) => {
      setOpen(false);
      try {
        await updateSettings({ firstRunWizardCompleted: true });
        const ipc = window.electron?.ipcRenderer;
        // Mark legacy onboarding complete so the in-app tour can run next.
        if (ipc?.invoke) await ipc.invoke("onboarding:set-completed", true);
      } catch {
        /* ignore */
      }
      if (navigateTo) {
        navigate({ to: navigateTo, ...(navigateSearch ? { search: navigateSearch } : {}) });
      }
    },
    [updateSettings, navigate],
  );

  const handleOpenFolder = useCallback(async () => {
    await finish();
    try {
      await openWorkspaceFromDirectoryPicker({
        navigate: (opts) => navigate(opts),
        refreshApps,
      });
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }, [finish, navigate, refreshApps]);

  if (!open) return null;

  const stepDots = (
    <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}>
      {Array.from({ length: TOTAL_STEPS }, (_, i) => (
        <span
          key={i}
          className={
            i === step
              ? "h-1.5 w-5 rounded-full bg-primary"
              : "h-1.5 w-1.5 rounded-full bg-muted-foreground/30"
          }
        />
      ))}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && void finish()}>
      <DialogContent className="max-w-md" data-testid="first-run-wizard">
        {step === 0 ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Rocket className="h-4 w-4 text-primary" />
                Welcome to Atlarix
              </DialogTitle>
              <DialogDescription>
                The agent workstation for software development.
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                Open a project folder — chat, sessions, tools, and memory belong to that workspace.
              </li>
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                Work modes: Explore, Plan, Build, Debug, Review (Shift+Tab to cycle).
              </li>
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                Every file write and command waits for your approval — inline in chat, with diffs.
              </li>
            </ul>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-primary" />
                Models & providers
              </DialogTitle>
              <DialogDescription>
                Use Atlarix Core (managed) or bring your own keys.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
                <Compass className="h-4 w-4 shrink-0 text-primary" />
                <span className="flex-1">Atlarix Core</span>
                <span className="text-xs text-muted-foreground">
                  {signedIn == null ? "…" : signedIn ? "Signed in" : "Sign in to use"}
                </span>
              </div>
              <div className="rounded-md border border-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1">Your API keys (BYOK)</span>
                  <span className="text-xs text-muted-foreground">
                    {detectedProviders.length > 0
                      ? `${detectedProviders.length} detected`
                      : "none yet"}
                  </span>
                </div>
                {detectedProviders.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {detectedProviders.map((p) => p.label).join(", ")}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, and more.
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void finish("/settings")}
              >
                <SettingsIcon className="h-3.5 w-3.5" />
                Open Settings → AI
              </Button>
              <div className="rounded-md border border-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1">MCP marketplace</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => void finish("/settings/mcp", { tab: "marketplace" })}
                  >
                    Browse
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  One-click integrations (GitHub, Slack, search, …) per workspace.
                  Marketplace installs are a Studio/Team feature — browsing is free.
                </p>
              </div>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                Default model
              </DialogTitle>
              <DialogDescription>
                Pick the model the agent uses by default — change it anytime from the chat composer.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border border-border/60 px-3 py-2 text-sm">
              <span className="text-muted-foreground text-xs">Current default</span>
              <div className="font-medium">
                {selectedModel?.name?.trim() || "Auto (Atlarix picks per task)"}
              </div>
              {selectedModel?.provider ? (
                <div className="text-xs text-muted-foreground capitalize">
                  via {selectedModel.provider}
                </div>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              The model picker lives next to the chat input; the agent shows which model authored each turn.
            </p>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-primary" />
                Open your first workspace
              </DialogTitle>
              <DialogDescription>
                Atlarix is workspace-first — point it at a project folder or clone a repo from the welcome screen.
              </DialogDescription>
            </DialogHeader>
            <Button type="button" className="gap-2" onClick={() => void handleOpenFolder()}>
              <FolderOpen className="h-4 w-4" />
              Open folder…
            </Button>
          </>
        ) : null}

        <DialogFooter className="flex items-center sm:justify-between gap-2">
          {stepDots}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void finish()}
            >
              Skip setup
            </Button>
            {step > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>
                Back
              </Button>
            ) : null}
            {step < TOTAL_STEPS - 1 ? (
              <Button type="button" size="sm" onClick={() => setStep((s) => s + 1)}>
                {step === 0 ? "Get started" : "Next"}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => void finish()}>
                Finish
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
