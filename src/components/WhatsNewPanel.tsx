import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import type { WhatsNewEntry } from "@/main/whats-new";

/**
 * A small, closable note in the bottom-left corner.
 *
 * DELIBERATELY MODEST. The website changelog does the real work; this is a
 * pointer to it. A line or two and a link — the moment it wants scrolling it has
 * become a second changelog, and there already is one. No badges, no unread
 * counts, no server-side targeting: those are a product, and this is a footnote.
 *
 * DISMISSAL IS KEYED ON THE ENTRY ID, not the app version. That is the whole
 * difference between a note and an advert: dismissing one note must not silence
 * the next, and a new note must not be resurrected for someone who already read
 * it. `UpdateBanner` established this pattern with
 * `atlarix_update_banner_dismissed_${version}`; the key here is the entry id
 * because the note is published independently of releases.
 *
 * RENDERS NOTHING when there is no note, when the fetch failed, or when this id
 * was dismissed. An empty card with a close button reads as a bug, and the panel
 * has no loading state for the same reason — there is nothing worth showing a
 * spinner for.
 *
 * NOT the update banner. That one says "a NEWER version exists" from the top of
 * the content area; this says something about the version you are running. They
 * can be on screen at once, which is fine — they are different messages — but
 * `main/update-helpers.ts` documents that this codebase has been bitten once by
 * two update surfaces firing together, so it is worth knowing they are separate
 * on purpose.
 */

const DISMISS_PREFIX = "atlarix_whats_new_dismissed_";

function dismissKey(id: string): string {
  return `${DISMISS_PREFIX}${id}`;
}

function isDismissed(id: string): boolean {
  try {
    return localStorage.getItem(dismissKey(id)) === "1";
  } catch {
    // Storage disabled or a private window. Showing the note is the better
    // failure: at worst it reappears, which beats never appearing at all.
    return false;
  }
}

export function WhatsNewPanel() {
  const [entry, setEntry] = useState<WhatsNewEntry | null>(null);
  const selectedAppId = useAtomValue(selectedAppIdAtom);

  const load = useCallback(async () => {
    const next = await IpcClient.getInstance().getWhatsNew();
    setEntry(next && !isDismissed(next.id) ? next : null);
  }, []);

  useEffect(() => {
    void load();
    // The hosted note refreshes hourly in main; without this a long-running
    // window would never see one published after launch, which is precisely the
    // case this whole mechanism exists for.
    const off = IpcClient.getInstance().onWhatsNewChanged(() => void load());
    return off;
  }, [load]);

  // A footnote for the home screen. Over an open workspace it covered the
  // composer (QA #8); it waits, undismissed, until you are back home.
  if (!entry || selectedAppId != null) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(entry.id), "1");
    } catch {
      // Nothing to do — it will come back next launch, which is a smaller
      // failure than a panel that cannot be closed.
    }
    setEntry(null);
  };

  return (
    <div
      role="status"
      className="absolute bottom-4 left-4 z-30 w-[20rem] max-w-[calc(100%-2rem)] rounded-xl border border-border bg-card p-4 shadow-lg animate-in slide-in-from-bottom-5"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      <h3 className="mb-1 pr-6 text-sm font-medium text-foreground">
        {entry.title}
      </h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {entry.body}
      </p>

      {entry.link ? (
        <button
          type="button"
          // `openExternalUrl` and not an <a>: this is an Electron renderer, and a
          // plain link would navigate the app window itself. The URL was already
          // validated as https in main.
          onClick={() =>
            void IpcClient.getInstance().openExternalUrl(entry.link!)
          }
          className="mt-2 text-xs font-medium text-primary hover:underline"
        >
          {entry.linkLabel ?? "Read more"} →
        </button>
      ) : null}
    </div>
  );
}

export default WhatsNewPanel;
