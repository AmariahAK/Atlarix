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

import { useAtom } from "jotai";
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";

import { AppSearchDialog } from "./AppSearchDialog";
import { appSearchOpenAtom, selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";

export function GlobalAppSearch() {
  const [open, setOpen] = useAtom(appSearchOpenAtom);
  const [, setSelectedAppId] = useAtom(selectedAppIdAtom);
  const { apps } = useLoadApps();
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
        setSelectedAppId(id);
        setOpen(false);
        // The palette is reachable from Settings and Integrations now, so
        // picking a workspace has to take you to it rather than silently
        // changing the selection behind whatever page you were on.
        void navigate({ to: "/" });
      }}
    />
  );
}
