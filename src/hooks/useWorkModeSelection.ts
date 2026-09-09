/**
 * Choosing a work mode — ONE implementation, for every control that offers it.
 *
 * There are two such controls (the composer's picker and the Shift+Tab cycle) and
 * they had drifted apart: the picker wrote the global preference AND stamped the
 * session, while Shift+Tab wrote only the global. Since a turn dispatches with
 * `workModeOverride ?? sessionWorkMode`, that meant Shift+Tab **did not change the
 * mode at all** for any session that had one stored — the toast said "Mode: Explore"
 * and the next turn still ran as Build. Reading was split the same way: the shortcut
 * cycled from the global value, so in such a session it also started from the wrong
 * mode and skipped one.
 *
 * The composer footer resolving the mode its own third way is what made this visible,
 * but it was never only a display bug. Every control now reads through
 * `resolveSelectedWorkMode` and writes through this one setter.
 */

import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { IpcClient } from "@/ipc/ipc_client";
import {
  activeSessionWorkModeAtom,
  activeWorkspaceSessionIdAtom,
} from "@/atoms/sessionAtoms";
import {
  resolveSelectedWorkMode,
  settingsPatchForWorkMode,
} from "@/lib/work-mode";
import type { WorkMode } from "@/lib/schemas";

export function useWorkModeSelection(): {
  /** The mode the next turn will run in. */
  workMode: WorkMode;
  setWorkMode: (mode: WorkMode) => void;
} {
  const { settings, updateSettings } = useSettings();
  const sessionWorkMode = useAtomValue(activeSessionWorkModeAtom);
  const setSessionWorkMode = useSetAtom(activeSessionWorkModeAtom);
  const activeSessionId = useAtomValue(activeWorkspaceSessionIdAtom);

  const workMode = resolveSelectedWorkMode({
    sessionWorkMode,
    workModePreference: settings?.workModePreference,
    selectedChatMode: settings?.selectedChatMode,
  });

  // Stable, so a consumer can list it in an effect's deps without rebinding a
  // global key listener on every render.
  const setWorkMode = useCallback(
    (mode: WorkMode) => {
      // Picking a mode clears any stale selected sub-agent (agents are task-tool
      // targets, not modes).
      //
      // The global write STAYS: it is the default for the next NEW session, which is
      // what makes the choice feel sticky when you start a fresh chat.
      void updateSettings({
        ...settingsPatchForWorkMode(mode),
        selectedAgent: "",
      });
      // And the session gets it too, so the choice survives being reopened from a
      // window whose global preference has since moved on — and, more immediately, so
      // that it is the value the next turn actually dispatches with. Optimistic: the
      // atom is set before the write lands, because the chip must not lag the input.
      if (activeSessionId) {
        setSessionWorkMode(mode);
        void IpcClient.getInstance()
          .setWorkspaceSessionWorkMode(activeSessionId, mode)
          .catch((e) => {
            // A failed stamp is not worth interrupting anything for — the global write
            // above still applies — but it must not be silent, or the session would
            // quietly keep resolving from the global forever.
            console.warn("[work-mode] failed to persist session mode:", e);
          });
      }
    },
    [updateSettings, activeSessionId, setSessionWorkMode],
  );

  return { workMode, setWorkMode };
}
