/**
 * A one-time, anchored hint that dims everything except the thing it points at.
 *
 * WHY THIS EXISTS RATHER THAN A TOUR LIBRARY. Shepherd.js was here first and was
 * removed with this component: it shipped with its own stylesheet and no theme
 * integration at all, so the popover was a hard `#fff` card and the overlay a flat
 * black wash — correct-looking in light mode, obviously wrong in dark. It was also
 * typed as a bare `declare module`, so every call into it was unchecked. Three
 * quarters of its code (the per-feature tours) was unreachable.
 *
 * THE PATTERN IS NOT NEW EITHER. `ChatIntentSelector` has shipped exactly this
 * shape for a while — a Radix `Popover` anchored to the control it explains, shown
 * once and remembered. This is that, generalised, with the dim backdrop added.
 *
 * ANCHORING IS BY COMPOSITION, NOT BY SELECTOR. The caller wraps the real control
 * as `children`; we make it the `PopoverAnchor`. A `querySelector` against a
 * `data-tour` attribute would work until someone renames the attribute, and then
 * fail silently at runtime in a way no test would catch — Shepherd did that too,
 * and two of its four tours pointed at anchors that no longer exist in the DOM.
 *
 * THE SPOTLIGHT IS A Z-INDEX, NOT A CUTOUT. The backdrop covers the viewport at
 * `z-50`; while open, the anchor is lifted to `z-[60]` with a ring. That reads as a
 * spotlight without any rect measurement, so it cannot drift when the composer
 * reflows, and it keeps working if the anchor is scrolled or resized mid-hint.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface CoachmarkProps {
  open: boolean;
  /** Called for every dismissal route — button, Esc, backdrop, or click-through. */
  onDismiss: () => void;
  title: string;
  body: string;
  /**
   * A keyboard chord to show beside the body, already formatted for this platform.
   * Callers pass `formatCombo(...)` from `lib/shortcuts.ts` — never a literal, so a
   * hint cannot advertise a key the handler does not listen for.
   */
  keys?: string;
  /** Label for the confirm button (the last step's, when part of a sequence). */
  actionLabel: string;
  /**
   * Sequence position, when this coachmark is one step of a guided tour.
   *
   * Both must be present for the progress dots and the "Next" button to appear. A
   * lone hint (the BYOK one) passes neither and renders exactly as before.
   */
  stepIndex?: number;
  stepCount?: number;
  /** Advance the sequence. When absent, the primary button dismisses instead. */
  onNext?: () => void;
  /** Label for the advance button. Required when `onNext` is set. */
  nextLabel?: string;
  /** Label for the "leave the tour" button, shown only in a sequence. */
  skipLabel?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** The control being explained. Becomes the popover's anchor and the spotlight. */
  children: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function Coachmark({
  open,
  onDismiss,
  title,
  body,
  keys,
  actionLabel,
  stepIndex,
  stepCount,
  onNext,
  nextLabel,
  skipLabel,
  side = "top",
  align = "end",
  children,
  className,
  "data-testid": testId = "coachmark",
}: CoachmarkProps) {
  const isSequence = stepIndex !== undefined && stepCount !== undefined;
  /*
   * Portalled rather than rendered in place: the composer row is inside several
   * stacking contexts (the panel splitter, the sticky footer), and a backdrop that
   * inherits one of them dims only part of the window. `document.body` has no such
   * parent. Guarded for the non-DOM case so this stays importable in a node test.
   */
  const backdrop =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            data-testid={`${testId}-backdrop`}
            aria-hidden="true"
            onClick={onDismiss}
            className={cn(
              "fixed inset-0 z-50 bg-background/70 backdrop-blur-sm",
              "animate-in fade-in-0",
            )}
          />,
          document.body,
        )
      : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      {backdrop}
      <PopoverAnchor asChild>
        <span
          className={cn(
            "inline-flex",
            // Lifted above the backdrop while the hint is up — this is the spotlight.
            open &&
              "relative z-[60] rounded-md ring-2 ring-primary ring-offset-2 ring-offset-background",
            className,
          )}
        >
          {children}
        </span>
      </PopoverAnchor>

      <PopoverContent
        side={side}
        align={align}
        sideOffset={10}
        data-testid={testId}
        className="z-[61] w-80"
        /*
         * Radix returns focus to the anchor on close, which would re-open the
         * dropdown the hint is pointing at. The caller wants the click to land on
         * the control, not to bounce focus back to it.
         */
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={actionLabel}
            className="-mr-1 -mt-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
        {keys ? (
          <p className="mt-2 text-xs text-muted-foreground">
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[11px] text-foreground">
              {keys}
            </kbd>
          </p>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          {/*
            Progress dots, mirroring the wizard's. A guided tour with no sense of
            length is a tour you cannot decide to sit through — the user should be
            able to see it is three steps, not an unbounded stream of tips.
          */}
          {isSequence ? (
            <div
              className="flex items-center gap-1.5"
              aria-label={`Step ${(stepIndex ?? 0) + 1} of ${stepCount}`}
            >
              {Array.from({ length: stepCount ?? 0 }, (_, i) => (
                <span
                  key={i}
                  className={
                    i === stepIndex
                      ? "h-1.5 w-4 rounded-full bg-primary"
                      : "h-1.5 w-1.5 rounded-full bg-muted-foreground/30"
                  }
                />
              ))}
            </div>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {isSequence ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onDismiss}
                data-testid={`${testId}-skip`}
              >
                {skipLabel}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              onClick={onNext ?? onDismiss}
              data-testid={`${testId}-primary`}
            >
              {onNext ? (nextLabel ?? actionLabel) : actionLabel}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
