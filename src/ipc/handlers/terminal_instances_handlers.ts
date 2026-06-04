/**
 * IPC bridge for terminal instance tools ↔ renderer TerminalPanel state.
 */

import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import type { TerminalScopeState } from "@/lib/terminal-instance-store";
import {
  clearAllTerminalScopes,
  closeTerminalInstance,
  getTerminalScopeState,
  listTerminalInstances,
  openTerminalInstance,
  readTerminalInstance,
  resolveScopeKey,
  setTerminalScopeState,
} from "@/lib/terminal-instance-store";
import { killPty, killAllPtys } from "@/lib/pty/pty-session-manager";
import { deletePtyScrollback } from "./pty_handlers";

const logger = log.scope("terminal-instances-handlers");
const handle = createLoggedHandler(logger);

type ScopeParams = { chatId?: number | null; appId?: number | null };

function scopeFromParams(params: ScopeParams): string {
  return resolveScopeKey(params.chatId, params.appId);
}

export function registerTerminalInstancesHandlers(): void {
  handle(
    "terminal-instances:list",
    async (_event, params: ScopeParams) => {
      const scopeKey = scopeFromParams(params);
      return { scopeKey, instances: listTerminalInstances(scopeKey) };
    },
  );

  handle(
    "terminal-instances:read",
    async (
      _event,
      params: ScopeParams & { instanceId: string; maxLines?: number },
    ) => {
      const scopeKey = scopeFromParams(params);
      return readTerminalInstance(
        scopeKey,
        params.instanceId,
        params.maxLines ?? 200,
      );
    },
  );

  handle(
    "terminal-instances:open",
    async (
      _event,
      params: ScopeParams & {
        owner: "user" | "agent";
        label?: string;
        commandHint?: string;
        operationId?: string;
      },
    ) => {
      const scopeKey = scopeFromParams(params);
      return openTerminalInstance(scopeKey, {
        owner: params.owner,
        label: params.label,
        commandHint: params.commandHint,
        operationId: params.operationId,
      });
    },
  );

  handle(
    "terminal-instances:close",
    async (_event, params: ScopeParams & { instanceId: string }) => {
      const scopeKey = scopeFromParams(params);
      killPty(params.instanceId); // v10: closing a tab kills its interactive shell
      void deletePtyScrollback(params.instanceId); // drop persisted scrollback too
      return closeTerminalInstance(scopeKey, params.instanceId);
    },
  );

  handle(
    "terminal-instances:get-scope",
    async (_event, params: ScopeParams) => {
      const scopeKey = scopeFromParams(params);
      return { scopeKey, state: getTerminalScopeState(scopeKey) };
    },
  );

  handle(
    "terminal-instances:sync-scope",
    async (
      _event,
      params: ScopeParams & { state: TerminalScopeState },
    ) => {
      const scopeKey = scopeFromParams(params);
      setTerminalScopeState(scopeKey, params.state);
      return { ok: true as const };
    },
  );

  handle("terminal-instances:clear-all", async () => {
    killAllPtys(); // v10: reset also tears down interactive shells
    clearAllTerminalScopes();
    return { ok: true as const };
  });
}
