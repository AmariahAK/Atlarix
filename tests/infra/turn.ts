import { vi } from "vitest";
import { makeTestDb, type TestDb } from "./db";
import { makeTempWorkspace, type TempWorkspace } from "./workspace";
import { startFakeLlmServer, type FakeLlmServer } from "./scenario";
import { writeTestSettings } from "./settings";
import { makeFakeIpcEvent, type FakeIpcEvent } from "./ipc";

/**
 * Full agent-eval context: real temp workspace + real sqlite DB + in-process
 * fake LLM, with the custom provider row routing `getModelClient` at the
 * server. One per test FILE (the db singleton caches the first connection).
 */
export interface EvalContext {
  testDb: TestDb;
  ws: TempWorkspace;
  server: FakeLlmServer;
  providerId: string;
  modelName: string;
  appId: number;
  /** New ephemeral workspace chat (negative id) bound to the seeded app. */
  newChat(): Promise<number>;
  cleanup(): Promise<void>;
}

export async function setupEvalContext(opts?: {
  seedFiles?: Record<string, string>;
}): Promise<EvalContext> {
  const testDb = await makeTestDb();
  const ws = makeTempWorkspace(opts?.seedFiles);
  const server = await startFakeLlmServer();
  const { providerId, modelName } = await testDb.seedTestingProvider(
    server.baseURL,
  );
  const { appId } = await testDb.seedApp({ path: ws.dir });

  return {
    testDb,
    ws,
    server,
    providerId,
    modelName,
    appId,
    async newChat() {
      const { createStreamTransport } = await import(
        "@/lib/chat/stream-transport"
      );
      return createStreamTransport(appId);
    },
    async cleanup() {
      await server.close();
      ws.cleanup();
      testDb.cleanup();
    },
  };
}

type ChatStreamHandler = (
  event: Electron.IpcMainInvokeEvent,
  req: any,
) => Promise<unknown>;

let handlersRegistered = false;

/**
 * Register the real IPC handlers once and pull them out of the mocked
 * `ipcMain.handle` (vitest.setup.ts stubs electron). Lets evals invoke
 * `chat:stream` — and interactive counterparts like `execute-permission` —
 * directly. The mock's call list is re-scanned per lookup so handlers
 * registered by module side effects (permissions/handlers.ts) are found too.
 */
export async function getIpcHandler(channel: string): Promise<ChatStreamHandler> {
  const { ipcMain } = await import("electron");
  if (!handlersRegistered) {
    handlersRegistered = true;
    const { registerChatStreamHandlers } = await import(
      "@/ipc/handlers/chat_stream_handlers"
    );
    registerChatStreamHandlers();
    const { registerWorkspaceSessionHandlers } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    registerWorkspaceSessionHandlers();
    // execute-permission / reject-permission register at module import.
    await import("@/ipc/handlers/permissions/handlers");
  }
  const calls = vi.mocked(ipcMain.handle).mock.calls;
  const call = [...calls].reverse().find(([ch]) => ch === channel);
  if (!call) {
    throw new Error(
      `IPC handler not registered: ${channel}. Registered: ${[...new Set(calls.map((c) => c[0]))].join(", ")}`,
    );
  }
  return call[1] as ChatStreamHandler;
}

export interface TurnResult {
  fakeIpc: FakeIpcEvent;
}

/**
 * Drive one full turn through the REAL `chat:stream` handler.
 *
 * `settings` are merged into user-settings.json before dispatch — at minimum
 * the chat mode; the selected model always points at the fake server.
 * The prompt must embed `sc=<scenario-id>` so the server picks the script.
 */
export async function runTurn(
  ctx: EvalContext,
  opts: {
    chatId: number;
    prompt: string;
    mode: "agent" | "ask" | "build";
    settings?: Record<string, unknown>;
    /** Drive interactive flows (approvals…) while the stream runs. */
    during?: (fakeIpc: FakeIpcEvent) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<TurnResult> {
  writeTestSettings({
    selectedChatMode: opts.mode,
    // Work mode follows the chat mode unless the eval overrides it — the
    // default "ask" preference gates writes even in build chat mode.
    workModePreference: opts.mode === "ask" ? "ask" : "build",
    selectedModel: { name: ctx.modelName, provider: ctx.providerId },
    hasRunBefore: true,
    telemetryConsent: "opted_out",
    ...opts.settings,
  });

  const fakeIpc = makeFakeIpcEvent();
  const handler = await getIpcHandler("chat:stream");

  // The handler replies immediately (`void runStream()` + `return undefined`,
  // chat_stream_handlers.ts ~L7047) — the renderer listens to events instead.
  // The reliable terminal signal is chat:response:end, sent on EVERY path via
  // ensureTerminal() in the stream's finally block.
  await handler(fakeIpc.event, {
    chatId: opts.chatId,
    prompt: opts.prompt,
  });

  const endPromise = fakeIpc.waitFor(
    "chat:response:end",
    (p) => p?.chatId === opts.chatId,
    opts.timeoutMs ?? 25_000,
  );
  const duringPromise = opts.during?.(fakeIpc) ?? Promise.resolve();
  await Promise.all([endPromise, duringPromise]);

  return { fakeIpc };
}
