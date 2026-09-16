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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useAuth } from "@/lib/auth/useAuth";
import { useTranslation } from "react-i18next";
import { useGuidedTour } from "@/hooks/useGuidedTour";
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
      if (localStorage.getItem("atlarix_onboarding_done") === "true")
        return true;
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
  const { apps, refreshApps } = useLoadApps();
  const checkLegacyMarker = useLegacyOnboardingMarker();
  const { t: tOnboarding } = useTranslation("onboarding");
  const { start: startTour } = useGuidedTour();
  /** A returning user restarting the guide, not somebody with an empty app. */
  const hasWorkspaces = (apps?.length ?? 0) > 0;

  /**
   * Auth is a GATE here, not a display detail — see the effect below.
   *
   * This is UI gating and nothing else. `useAuth` is unshared per call site by
   * design, and none of the real enforcement lives in it: opening a workspace,
   * and every chat turn, are gated in the IPC handlers (`requireAuthSession`).
   * Do not promote this read into a security check.
   */
  const { isAuthenticated, authResolved } = useAuth();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [decided, setDecided] = useState(false);

  /**
   * "Restart guide" in Settings sets the flag back to false — re-evaluate.
   *
   * WATCHES THE TRANSITION, NOT THE STEADY STATE. This used to fire on the
   * standing condition `completed === false && decided && !open`, which is also
   * true every time the user steps out to Settings via `leaveWithoutFinishing` —
   * so it would snap them back to step 0 and undo the resume point. Only a real
   * true→false edge means somebody pressed Restart.
   */
  const prevCompleted = useRef(settings?.firstRunWizardCompleted);
  useEffect(() => {
    const now = settings?.firstRunWizardCompleted;
    const was = prevCompleted.current;
    prevCompleted.current = now;
    if (was === true && now === false) {
      setStep(0);
      setDecided(false);
    }
  }, [settings?.firstRunWizardCompleted]);

  /**
   * Gate: show only for genuinely new users; migrate legacy completion silently.
   *
   * THE AUTH GUARD IS LOAD-BEARING AND IT IS WHY THIS WIZARD NEVER RAN.
   *
   * `onboarding:get-completed` answers `{ completed: true }` when nobody is signed
   * in — "not logged in => no onboarding" (`auth_handlers.ts:524`). The legacy-marker
   * check below consults exactly that channel. And a fresh install is ALWAYS signed
   * out at the moment this effect first runs: the wizard is mounted globally in
   * `app/layout.tsx`, renders on `/sign-in`, and there is no session to restore.
   *
   * So the old order — legacy check first, auth afterwards and only for a label —
   * read a signed-out `true` as "already onboarded", wrote `firstRunWizardCompleted`
   * and returned without ever opening. It also never reached `finish()`, so the
   * Supabase `onboarding_completed` column stayed false, and that column is what
   * `TourManager` waits on. One ordering bug took out both onboarding surfaces.
   *
   * Two separate conditions, because they are different answers:
   *  - `!authResolved` — startup restore has not settled. NOT signed out; no
   *    decision may be taken yet, and in particular nothing may be written.
   *  - `!isAuthenticated` — genuinely signed out. Stay closed and stay UNDECIDED,
   *    so signing in re-runs this and opens the wizard without a reload.
   */
  useEffect(() => {
    if (decided || !settings) return;
    if (!authResolved || !isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      if (settings.firstRunWizardCompleted) {
        setDecided(true);
        return;
      }

      /*
       * `undefined` and `false` ARE DIFFERENT ANSWERS, and conflating them is what
       * made "Restart onboarding guide" do nothing.
       *
       * The legacy marker reads `onboarding:get-completed`, which for a signed-in
       * user who has onboarded before answers TRUE — that is what the column is for.
       * Consulting it unconditionally means every restart is vetoed: Restart writes
       * `false`, the gate asks the server, the server says "they onboarded", and the
       * wizard re-marks itself complete instead of opening.
       *
       * `firstRunWizardCompleted` is optional, so:
       *  - ABSENT  = never evaluated on this install; the pre-v10 migration may still
       *              apply, so ask the legacy marker.
       *  - `false` = a DECISION already recorded — a new user mid-flow, or someone who
       *              just pressed Restart. Nothing older gets to override that.
       *
       * The alternative fix, writing `onboarding:set-completed(false)` from Restart,
       * is what the old code did and it is worse: it tells the server that a user of
       * long standing has never onboarded, corrupting the flag for everything else
       * that reads it, purely to smuggle a signal past this check.
       */
      const neverEvaluated = settings.firstRunWizardCompleted === undefined;
      const legacyDone = neverEvaluated ? await checkLegacyMarker() : false;
      if (cancelled) return;
      setDecided(true);
      if (legacyDone) {
        void updateSettings({ firstRunWizardCompleted: true });
        return;
      }
      if (!cancelled) setOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    settings,
    decided,
    checkLegacyMarker,
    updateSettings,
    authResolved,
    isAuthenticated,
  ]);

  const detectedProviders = useMemo(() => {
    const ps = settings?.providerSettings ?? {};
    return KNOWN_PROVIDERS.filter((p) => {
      const entry = (ps as Record<string, { apiKey?: { value?: string } }>)[
        p.id
      ];
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
        navigate({
          to: navigateTo,
          ...(navigateSearch ? { search: navigateSearch } : {}),
        });
        return;
      }
      /*
       * Finishing the wizard hands straight over to the guided tour, which points at
       * the real controls in the composer instead of sending the user off to another
       * screen to read about them. Only when we are STAYING here — a wizard exit that
       * navigates elsewhere has no composer to anchor to.
       */
      navigate({ to: "/" });
      startTour();
    },
    [updateSettings, navigate, startTour],
  );

  /**
   * Leave to look at something, WITHOUT completing.
   *
   * "Open Settings → AI" used to call `finish()`, which set
   * `firstRunWizardCompleted` on the way out — so the one user who followed the
   * wizard's own advice to go and add an API key was also the one user who never
   * saw step 2, the step that says where the model picker is. That is the whole
   * BYOK dead end, created by the screen that was supposed to prevent it.
   *
   * Closing without deciding leaves the gate effect free to re-open the wizard
   * when the user comes back, and `resumeStep` puts them on the step after the
   * one they left from rather than back at "Welcome".
   */
  const leaveWithoutFinishing = useCallback(
    (
      navigateTo: string,
      resumeStep: number,
      navigateSearch?: Record<string, string>,
    ) => {
      setOpen(false);
      setDecided(false);
      setStep(resumeStep);
      navigate({
        to: navigateTo,
        ...(navigateSearch ? { search: navigateSearch } : {}),
      });
    },
    [navigate],
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
    <div
      className="flex items-center gap-1.5"
      aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}
    >
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
    <>
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
                  The private AI workstation — your code stays on your machine.
                </DialogDescription>
              </DialogHeader>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex gap-2">
                  <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                  Open a project folder — chat, sessions, tools, and memory
                  belong to that workspace.
                </li>
                <li className="flex gap-2">
                  <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                  Work modes: Explore, Plan, Build, Debug, Review (Shift+Tab to
                  cycle).
                </li>
                <li className="flex gap-2">
                  <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                  Every file write waits for your approval, inline in chat with
                  diffs. Commands run inside a per-OS sandbox; only genuinely
                  dangerous ones stop to ask.
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
                  Use Atlarix Core (pay-as-you-go — $1 free to start) or bring
                  your own keys.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
                  <Compass className="h-4 w-4 shrink-0 text-primary" />
                  <span className="flex-1">Atlarix Core</span>
                  {/* The "Sign in to use" / "Signed in" status that lived here is
                      gone: the wizard now only opens for a resolved, signed-in
                      session, so one branch was a tautology and the other was
                      unreachable. */}
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
                      OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio,
                      and more.
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => leaveWithoutFinishing("/settings", 2)}
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
                      onClick={() =>
                        leaveWithoutFinishing("/integrations/mcp", 2, {
                          tab: "marketplace",
                        })
                      }
                    >
                      Browse
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    One-click integrations (GitHub, Slack, search, …) per
                    workspace. Marketplace installs are a Pro feature — browsing
                    is free.
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
                  Pick the model the agent uses by default — change it anytime
                  from the chat composer.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-md border border-border/60 px-3 py-2 text-sm">
                <span className="text-muted-foreground text-xs">
                  Current default
                </span>
                <div className="font-medium">
                  {selectedModel?.name?.trim() ||
                    "Auto (Atlarix picks per task)"}
                </div>
                {selectedModel?.provider ? (
                  <div className="text-xs text-muted-foreground capitalize">
                    via {selectedModel.provider}
                  </div>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                The model picker lives next to the chat input; the agent shows
                which model authored each turn.
              </p>
            </>
          ) : null}

          {step === 3 ? (
            <>
              {/*
                THIS STEP HAS TO KNOW WHETHER YOU ARE ACTUALLY NEW.
                It was hardcoded "Open your first workspace", which was harmless
                only while the wizard could never run — now that "Restart guide"
                works, an existing user with open workspaces is told to open their
                first one, while the window behind the dialog is plainly showing
                the workspace they are already in. Copy that argues with the screen
                behind it reads as a broken app, not a friendly nudge.
              */}
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-primary" />
                  {hasWorkspaces
                    ? tOnboarding("workspace.titleExisting")
                    : tOnboarding("workspace.titleFirst")}
                </DialogTitle>
                <DialogDescription>
                  {hasWorkspaces
                    ? tOnboarding("workspace.bodyExisting")
                    : tOnboarding("workspace.bodyFirst")}
                </DialogDescription>
              </DialogHeader>
              {/* One entry point. "Clone repo…" used to sit beside this, opening a
                GitHub-only device flow — so it could never reach GitLab,
                Bitbucket, self-hosted or plain SSH. `git clone` through the
                agent works on every host with the user's own credentials, which
                is why the copy above points there instead. The v14.24.0 lesson
                still holds and is why this button is HERE rather than behind
                setup: a new user must be able to start without finishing a
                wizard first. */}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="gap-2"
                  onClick={() => void handleOpenFolder()}
                >
                  <FolderOpen className="h-4 w-4" />
                  {hasWorkspaces
                    ? tOnboarding("workspace.openAnother")
                    : tOnboarding("workspace.open")}
                </Button>
              </div>
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setStep((s) => s - 1)}
                >
                  Back
                </Button>
              ) : null}
              {step < TOTAL_STEPS - 1 ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setStep((s) => s + 1)}
                >
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
    </>
  );
}
