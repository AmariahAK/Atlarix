import { atom } from "jotai";

export type TerminalLineKind = "prompt" | "output" | "status";

export type TerminalLine = {
  id: string;
  prefix: "[Agent]" | "[You]";
  text: string;
  kind: TerminalLineKind;
};

export type TerminalInstance = {
  id: string;
  label: string;
  owner: "user" | "agent";
  lines: TerminalLine[];
  createdAt: number;
};

export function terminalScopeKey(
  chatId: number | null | undefined,
  appId: number | null | undefined,
): string {
  if (chatId != null) return `chat:${chatId}`;
  if (appId != null) return `app:${appId}`;
  return "global";
}

/** Persisted terminal tabs per chat/workspace scope */
export const terminalInstancesByScopeAtom = atom<
  Record<string, TerminalInstance[]>
>({});

/** Active terminal tab id per scope */
export const activeTerminalInstanceByScopeAtom = atom<Record<string, string>>(
  {},
);

/** Maps agent operationId → terminal instance id per scope */
export const terminalAgentOpMapByScopeAtom = atom<
  Record<string, Record<string, string>>
>({});
