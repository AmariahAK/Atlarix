/**
 * Shepherd.js product tours: first-run (after Supabase onboarding) + per-feature ? tours.
 */

import { useEffect, useRef, useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import { tourFeatureRequestAtom } from "@/atoms/tourAtoms";
import { rightPanelVisibleAtom } from "@/atoms/sourceAtoms";
type TourState = {
  firstRunCompleted: boolean;
  firstRunStep: number;
  dismissedAt: string | null;
  featureTours: Record<string, { completed: boolean; step: number }>;
};

function getInvoke(): ((ch: string, ...args: unknown[]) => Promise<unknown>) | null {
  return (window as unknown as { electron?: { ipcRenderer?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } } })
    .electron?.ipcRenderer?.invoke ?? null;
}

async function getTourState(): Promise<TourState | null> {
  const inv = getInvoke();
  if (!inv) return null;
  try {
    return (await inv("tour:get-state")) as TourState;
  } catch {
    return null;
  }
}

async function saveTourState(partial: Partial<TourState>): Promise<void> {
  const inv = getInvoke();
  if (!inv) return;
  try {
    await inv("tour:set-state", partial);
  } catch {
    /* ignore */
  }
}

function elementOrFallback(selector: string): boolean {
  try {
    return !!document.querySelector(selector);
  } catch {
    return false;
  }
}

export function TourManager() {
  const [featureReq, setFeatureReq] = useAtom(tourFeatureRequestAtom);
  const setRightVisible = useSetAtom(rightPanelVisibleAtom);
  const tourRef = useRef<{ cancel: () => void } | null>(null);
  const firstRunLaunched = useRef(false);

  const stopTour = useCallback(() => {
    try {
      tourRef.current?.cancel();
    } catch {
      /* ignore */
    }
    tourRef.current = null;
  }, []);

  const runFirstRunTour = useCallback(async () => {
    const Shepherd = (await import("shepherd.js")).default;
    stopTour();
    setRightVisible(true);

    const tour = new Shepherd.Tour({
      useModalOverlay: true,
      defaultStepOptions: {
        cancelIcon: { enabled: true },
        scrollTo: true,
        modalOverlayOpeningPadding: 4,
      },
    });

    const steps: Array<{
      id: string;
      title: string;
      text: string;
      attach?: string;
      on?: "top" | "bottom" | "left" | "right";
    }> = [
      {
        id: "welcome",
        title: "Welcome",
        text: "Quick tour: Ask vs Build, models, inline diagrams in chat, and the right panel.",
      },
      {
        id: "inline-viz",
        title: "Diagrams in chat",
        text: "Ask for architecture views — the assistant renders **mermaid** and **markmap** blocks inline in the conversation.",
        attach: '[data-tour="tour-ask-build"]',
        on: "bottom",
      },
      {
        id: "ask-build",
        title: "Ask vs Build",
        text: "**Ask** = read-only. **Build** = writes and commands (with approval).",
        attach: '[data-tour="tour-ask-build"]',
        on: "bottom",
      },
      {
        id: "model",
        title: "Model",
        text: "Choose the AI model here. With the right panel open, use the compact model search.",
        attach: '[data-tour="tour-model-picker"]',
        on: "top",
      },
      {
        id: "panel",
        title: "Right panel",
        text: "Preview, diagrams, diffs, tools, and more — beside your chat.",
        attach: '[data-tour="tour-activity-panel"]',
        on: "left",
      },
    ];

    steps.forEach((s, index) => {
      const isFirst = index === 0;
      const isLast = index === steps.length - 1;
      const hasAttach = !!(s.attach && elementOrFallback(s.attach));
      const attachTo =
        hasAttach && s.attach
          ? { element: s.attach, on: s.on || "bottom" }
          : undefined;

      tour.addStep({
        id: s.id,
        title: s.title,
        text: s.text,
        attachTo,
        buttons: [
          ...(isFirst
            ? []
            : [
                {
                  text: "Back",
                  action: () => tour.back(),
                  classes: "shepherd-button-secondary",
                },
              ]),
          {
            text: isLast ? "Done" : "Next",
            action: () => {
              if (isLast) {
                void saveTourState({ firstRunCompleted: true, firstRunStep: 0, dismissedAt: null });
                return tour.complete();
              }
              return tour.next();
            },
          },
        ],
        beforeShowPromise: () => {
          if (s.id === "panel") setRightVisible(true);
          return Promise.resolve();
        },
      });
    });

    tour.on("cancel", () => {
      void saveTourState({ dismissedAt: new Date().toISOString() });
    });

    tourRef.current = tour;
    tour.start();
  }, [setRightVisible, stopTour]);

  const runFeatureTour = useCallback(
    async (featureId: string) => {
      const Shepherd = (await import("shepherd.js")).default;
      stopTour();

      const definitions: Record<
        string,
        Array<{ title: string; text: string; attach?: string; on?: "top" | "bottom" | "left" | "right" }>
      > = {
        diagram: [
          { title: "Inline diagrams", text: "Request a diagram in chat — Mermaid and markmap fences render in the thread.", attach: '[data-tour="tour-ask-build"]', on: "bottom" },
          { title: "get_diagram tool", text: "The assistant can call get_diagram for workspace architecture; results appear as inline Mermaid in the reply.", attach: '[data-tour="tour-activity-panel"]', on: "left" },
        ],
        agents: [
          { title: "Agent modes", text: "**Direct** — no agents. **Guided** — flat delegation. **Autonomous** — nested agents.", attach: '[data-tour="tour-ask-build"]', on: "bottom" },
        ],
        extensions: [
          { title: "Workspace extensions", text: "DB, GitHub Actions, and more live under Settings → Workspace.", attach: '[data-tour="tour-extensions"]', on: "bottom" },
        ],
        db: [
          { title: "DB connections", text: "Add PostgreSQL, MySQL, or SQLite — the AI uses read tools and approvals for writes.", attach: '[data-tour="tour-db"]', on: "bottom" },
        ],
      };

      const defs = definitions[featureId];
      if (!defs?.length) return;

      const tour = new Shepherd.Tour({
        useModalOverlay: true,
        defaultStepOptions: { cancelIcon: { enabled: true }, scrollTo: true },
      });

      defs.forEach((s, index) => {
        const isFirst = index === 0;
        const isLast = index === defs.length - 1;
        const hasAttach = !!(s.attach && elementOrFallback(s.attach));
        const attachTo =
          hasAttach && s.attach ? { element: s.attach, on: s.on || "bottom" } : undefined;

        tour.addStep({
          id: `${featureId}-${index}`,
          title: s.title,
          text: s.text,
          attachTo,
          buttons: [
            ...(isFirst
              ? []
              : [
                  {
                    text: "Back",
                    action: () => tour.back(),
                    classes: "shepherd-button-secondary",
                  },
                ]),
            {
              text: isLast ? "Done" : "Next",
              action: () => {
                if (isLast) {
                  void (async () => {
                    const st = await getTourState();
                    await saveTourState({
                      featureTours: {
                        ...st?.featureTours,
                        [featureId]: { completed: true, step: 0 },
                      },
                    });
                  })();
                  return tour.complete();
                }
                return tour.next();
              },
            },
          ],
        });
      });

      tourRef.current = tour;
      tour.start();
    },
    [stopTour],
  );

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(async () => {
      if (firstRunLaunched.current) return;
      const inv = getInvoke();
      if (!inv || cancelled) return;
      const user = (await inv("auth:get-current-user")) as { user?: { id?: string } };
      if (!user?.user?.id) return;
      const ob = (await inv("onboarding:get-completed")) as { completed?: boolean };
      if (!ob?.completed) return;
      const state = await getTourState();
      if (!state || state.firstRunCompleted) return;
      if (cancelled) return;
      firstRunLaunched.current = true;
      await runFirstRunTour();
    }, 2800);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [runFirstRunTour]);

  useEffect(() => {
    if (!featureReq) return;
    const id = featureReq;
    setFeatureReq(null);
    void runFeatureTour(id);
  }, [featureReq, setFeatureReq, runFeatureTour]);

  useEffect(() => () => stopTour(), [stopTour]);

  return null;
}
