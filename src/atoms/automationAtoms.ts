import { atom } from "jotai";
import type { AutomationRunView } from "@/lib/automations/types";

export interface AutomationListItem {
  id: string;
  workspaceId: number | null;
  name: string;
  enabled: boolean;
  trigger: unknown;
  prompt: string;
  runMode: "notify-only" | "read-only";
  /** Does a finished run reach the AGENT, or only the user? Toggleable either way. */
  notifyAgent: boolean;
  model: { provider: string; name: string } | null;
  lastRunAt: number | null;
  createdAt: number;
}

export const automationsAtom = atom<AutomationListItem[]>([]);
export const automationRunsAtom = atom<AutomationRunView[]>([]);

/** Unread badge on the Automations tab icon. */
export const automationsUnreadCountAtom = atom(
  (get) =>
    get(automationRunsAtom).filter((r) => r.unread && !r.archived).length,
);

/** Set by the OS-notification click handler so the feed can scroll/highlight. */
export const automationsFocusRunIdAtom = atom<string | null>(null);
