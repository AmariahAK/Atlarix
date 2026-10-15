/**
 * The workspace-search palette, mounted once at the app root.
 *
 * WHY IT LIVES HERE AND NOT IN `AppList`.
 * `AppSearchDialog` owns the Cmd/Ctrl+K listener itself, so the chord only
 * worked while the dialog was mounted — and its only mount was inside
 * `AppList`, which returns `null` unless the Apps rail item is hovered or the
 * route is "/". The chord therefore did nothing on Settings, on Integrations,
 * on Tools, and on the chat page whenever the rail was not expanded.
 *
 * `shortcuts.ts` recorded this honestly rather than hiding it: the row was
 * `status: "hidden"` with a note saying advertising it "would manufacture bug
 * reports". Mounting the dialog where every other global dialog already lives
 * (`app/layout.tsx`, beside `CommunityDialog`) is what lets that row be
 * advertised instead of apologised for.
 */

import { useAtom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";

import { AppSearchDialog } from "./AppSearchDialog";
import { appSearchOpenAtom, selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { openWorkspaceByAppId } from "@/lib/open-workspace-session";

export function GlobalAppSearch() {
  const [open, setOpen] = useAtom(appSearchOpenAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { apps, refreshApps } = useLoadApps();
  const navigate = useNavigate();

  const allApps = useMemo(
    () =>
      apps.map((a) => ({
        id: a.id,
        name: a.name,
        createdAt: a.createdAt,
        matchedChatTitle: null,
        matchedChatMessage: null,
      })),
    [apps],
  );

  return (
    <AppSearchDialog
      open={open}
      onOpenChange={setOpen}
      allApps={allApps}
      onSelectApp={(id) => {
        setOpen(false);
        // The palette is reachable from Settings and Integrations now, so
        // picking a workspace has to take you to it rather than silently
        // changing the selection behind whatever page you were on.
        if (id === selectedAppId) {
          void navigate({ to: "/" });
          return;
        }
        // Opened as the welcome screen's recents open it: its own session and
        // chat. Setting the selection alone moved the header and sidebar while
        // the chat (and the next message) stayed on the previous workspace,
        // and one never opened in the app hung on "Loading workspace…"
        // (QA 15.7.1 #6, #6b).
        void openWorkspaceByAppId({
          appId: id,
          navigate: (opts) => void navigate(opts),
          refreshApps,
        });
      }}
    />
  );
}
