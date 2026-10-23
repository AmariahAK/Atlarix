import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
import { formatModelApiNameForDisplay } from "@/lib/format-openrouter-model-label";
import type { CoreSlotChange } from "@/lib/routing/core-slot-change";

/**
 * One-time notice that the model behind the user's Core slot changed.
 *
 * WHY IT IS NEEDED. A Core slot names a slot, not a model, and which model sits
 * behind it comes from `core-models.json` — so it changes without an app update, and
 * has done silently before. The user's selection reads identically while their
 * per-turn cost can move several-fold (Astra is roughly five times Terra). This is
 * the one place that says so.
 *
 * DISMISSAL IS PERSISTED, NOT AN IN-MEMORY ATOM. A jotai atom is cleared by a
 * reload, which would make a once-ever notice reappear forever. The
 * persistence here is the main-side baseline: acknowledging advances it, after which
 * the notice cannot fire again for that change. Deliberately NOT localStorage — the
 * tier→model truth lives in main, and a second store would be a second answer.
 */
export function CoreSlotChangeBanner() {
  const [change, setChange] = useState<CoreSlotChange | null>(null);
  // Re-check when the user picks a model: their own pick moves the baseline
  // (useSelectModel), so a notice on screen must not outlive it (QA #46).
  const { settings } = useSettings();
  const selectedKey = `${settings?.selectedModel?.provider ?? ""}/${settings?.selectedModel?.name ?? ""}`;

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const next = await IpcClient.getInstance().getCoreSlotChangeNotice();
        if (!cancelled) setChange(next);
      } catch {
        // A notice is a nicety; never let it surface as a chat error.
      }
    };
    void check();
    // The lineup refreshes hourly in main, so a long-running window could be moved
    // onto a different model without ever relaunching — which is precisely the case
    // this notice exists for.
    const off = IpcClient.getInstance().onCoreModelsChanged(() => void check());
    return () => {
      cancelled = true;
      off?.();
    };
  }, [selectedKey]);

  const dismiss = useCallback(() => {
    // Hide first, acknowledge after: the user's click should never wait on IPC, and
    // a failed ack simply means the notice returns next launch — a smaller failure
    // than a banner that will not close.
    setChange(null);
    void IpcClient.getInstance()
      .ackCoreSlotChange()
      .catch(() => {});
  }, []);

  if (!change) return null;

  return (
    <div
      data-testid="core-slot-change-banner"
      className="mx-4 mb-2 px-3 py-2 rounded-md border border-border/60 bg-muted/40 text-xs text-muted-foreground flex items-start gap-2"
    >
      <p className="flex-1">
        Your Atlarix Core model changed from{" "}
        <span className="font-medium text-foreground">
          {formatModelApiNameForDisplay(change.from)}
        </span>{" "}
        to{" "}
        <span className="font-medium text-foreground">
          {formatModelApiNameForDisplay(change.to)}
        </span>
        . Pricing differs between models — you can pick a different one from the
        model selector at any time.
      </p>
      <button
        type="button"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
