import { useMemo } from "react";
import { LightbulbIcon } from "lucide-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { rightPanelOrderedTabsAtom } from "@/atoms/sourceAtoms";
import { buildTipPool, pickTip } from "@/lib/composer-tips";
import { isMacPlatform } from "@/lib/shortcuts";

/**
 * The launch key.
 *
 * Module scope, so it is fixed for the lifetime of the window — which is what makes the
 * tip hold still. Combined with the chat id it gives "one tip per chat per launch": a new
 * chat may show a different tip, but re-rendering the composer never changes the one
 * you are currently reading. See `lib/composer-tips.ts` for why that matters more than
 * randomness does.
 */
const LAUNCH_KEY = String(Date.now());

/**
 * A single rotating tip under the composer.
 *
 * Renders nothing most of the time — see the eligibility rules below and the policy in
 * `lib/composer-tips.ts`. Deliberately has no dismiss control: it is already absent on a
 * third of eligible moments and vanishes the instant you type, so a persistent "never
 * show again" would be more chrome than the feature is worth.
 *
 * All prose comes from the `tips` catalog via `t()`, and every chord comes from
 * `lib/shortcuts.ts`. Neither is written here, for two different reasons: a literal chord
 * could drift from the handler, and a literal string would count against `check:i18n`'s
 * hardcoded-JSX ratchet.
 */
export function ComposerTip({
  chatId,
  composerIsEmpty,
  isStreaming,
  mustSignIn,
}: {
  chatId?: number;
  composerIsEmpty: boolean;
  isStreaming: boolean;
  mustSignIn: boolean;
}) {
  const { t } = useTranslation("tips");
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const orderedTabs = useAtomValue(rightPanelOrderedTabsAtom);

  const tip = useMemo(() => {
    const pool = buildTipPool(
      {
        inWorkspaceChat: selectedAppId != null,
        hasMultiplePanelTabs: orderedTabs.tabs.length >= 2,
        isMac: isMacPlatform(),
      },
      {
        shortcutAction: (id, fallback) =>
          t(`shortcuts.${id}`, { defaultValue: fallback }),
        feature: (id) => t(`feature.${id}`),
      },
    );
    return pickTip(`${LAUNCH_KEY}:${chatId ?? "none"}`, pool);
  }, [chatId, selectedAppId, orderedTabs.tabs.length, t]);

  /*
   * Eligibility. Each condition earns its place:
   *  - a tip belongs to an empty composer, not under a half-typed message;
   *  - not while a turn streams, when there is real output to read;
   *  - not when signed out, where `SignInToChatNotice` already occupies the slot and a
   *    tip about ⌘J under a sign-in prompt is pure noise.
   */
  if (mustSignIn || isStreaming || !composerIsEmpty || !tip) return null;

  return (
    <div
      data-testid="composer-tip"
      className="mt-2 px-1 flex items-start gap-1.5 text-xs text-muted-foreground/80"
    >
      <LightbulbIcon className="h-3.5 w-3.5 shrink-0 mt-px" />
      <span className="min-w-0">
        {tip.keys ? (
          <>
            <kbd className="rounded border border-border bg-muted px-1 py-px font-sans text-[11px]">
              {tip.keys}
            </kbd>{" "}
            {tip.text}
          </>
        ) : (
          tip.text
        )}
      </span>
    </div>
  );
}
