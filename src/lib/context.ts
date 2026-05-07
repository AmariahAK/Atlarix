/**
 * Atlarix Context References - v7.1.2
 * AsyncLocalStorage-based context propagation for workspace and chat state.
 */

import { AsyncLocalStorage } from "async_hooks";

export interface WorkspaceContext {
  workspaceId: number;
  workspacePath: string;
  projectRoot: string;
}

export interface ChatContext {
  chatId: number;
  sessionId: string;
  modelName: string;
}

export interface OperationContext {
  requestId: string;
  operationType: string;
  startTime: Date;
}

interface FullContext {
  workspace?: WorkspaceContext;
  chat?: ChatContext;
  operation?: OperationContext;
}

const contextStorage = new AsyncLocalStorage<FullContext>();

export const Context = {
  getWorkspace(): WorkspaceContext | undefined {
    return contextStorage.getStore()?.workspace;
  },

  getChat(): ChatContext | undefined {
    return contextStorage.getStore()?.chat;
  },

  getOperation(): OperationContext | undefined {
    return contextStorage.getStore()?.operation;
  },

  getAll(): FullContext {
    return contextStorage.getStore() ?? {};
  },

  runWithWorkspace<T>(workspace: WorkspaceContext, fn: () => T): T {
    const store = contextStorage.getStore() ?? {};
    return contextStorage.run({ ...store, workspace }, fn);
  },

  runWithChat<T>(chat: ChatContext, fn: () => T): T {
    const store = contextStorage.getStore() ?? {};
    return contextStorage.run({ ...store, chat }, fn);
  },

  runWithOperation<T>(operation: OperationContext, fn: () => T): T {
    const store = contextStorage.getStore() ?? {};
    return contextStorage.run({ ...store, operation }, fn);
  },

  runWithAll<T>(context: FullContext, fn: () => T): T {
    return contextStorage.run(context, fn);
  },

  createWorkspaceContext(workspaceId: number, workspacePath: string, projectRoot: string): WorkspaceContext {
    return { workspaceId, workspacePath, projectRoot };
  },

  createChatContext(chatId: number, sessionId: string, modelName: string): ChatContext {
    return { chatId, sessionId, modelName };
  },

  createOperationContext(requestId: string, operationType: string): OperationContext {
    return { requestId, operationType, startTime: new Date() };
  },
};

export type { FullContext as ContextStore };