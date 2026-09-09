import { useTranslation } from "react-i18next";
import { advertisedShortcuts, formatCombo, isMacPlatform } from "@/lib/shortcuts";

/**
 * The keyboard-shortcut reference, rendered from `lib/shortcuts.ts`.
 *
 * WHY THIS EXISTS AT ALL. The app had NO shortcut documentation. `HelpDialog` carried
 * none, and the only user-facing list anywhere was a line in `CHANGELOG_PREVIOUS.md`
 * that omitted ⌘B, ⌘/, ⌘K and Shift+Tab — so several genuinely useful chords were
 * undiscoverable unless you read the source. The tips line under the composer is
 * discovery; this is the thing a user can come back to.
 *
 * Every row comes from the shared table, whose conformance test dispatches synthesised
 * events at the real handler — so a chord printed here cannot be one the app does not
 * listen for. Rows marked `hidden` are excluded: ⌘K's listener unmounts with the Apps
 * sidebar, and documenting a shortcut that usually does nothing is worse than silence.
 *
 * Prose comes from the `tips` catalog rather than JSX literals, both so it can be
 * translated and because `check:i18n` counts hardcoded JSX text — this file would
 * otherwise have added a dozen strings to the ratchet on its own.
 */
export function ShortcutsList() {
  const { t } = useTranslation("tips");
  const isMac = isMacPlatform();
  const rows = advertisedShortcuts();

  return (
    <div className="flex flex-col space-y-2">
      <p className="text-sm font-medium px-2">{t("help.title")}</p>
      {/*
        Its own scroll container. `DialogContent` has none in either of this dialog's
        views, so a list long enough to overflow would otherwise push the dialog past
        the viewport instead of scrolling inside it.
      */}
      <div className="max-h-56 overflow-y-auto rounded-md border border-border divide-y divide-border">
        {rows.map((s) => (
          <div
            key={s.id}
            className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
          >
            <span className="min-w-0">
              {t(`shortcuts.${s.id}`, { defaultValue: s.label })}
              {s.scope ? (
                <span className="block text-xs text-muted-foreground">
                  {t("help.scopeNote", { scope: s.scope })}
                </span>
              ) : null}
            </span>
            <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs">
              {formatCombo(s.combo, isMac)}
            </kbd>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground px-2">{t("help.caption")}</p>
    </div>
  );
}
