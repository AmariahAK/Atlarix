/**
 * Headless agent runner — drives the REAL `chat:stream` loop in plain Node
 * (no Electron, no UI), used by the standalone CLI (`atlarix-headless`) and the
 * benchmark adapters. Reuses prod modules; the only "test-shaped" pieces are the
 * fake sender + auto-approve, which live in src/headless (not tests/).
 *
 * Provider is a custom OpenAI-compatible endpoint (DeepSeek/Atlarix Core/Ollama)
 * resolved by `getModelClient` from a seeded DB row + settings.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakeSender } from "./fake-sender";
import { autoApprove } from "./auto-approve";

export interface HeadlessProvider {
  /**
   * Builtin provider id (e.g. "openrouter") to use the app's native provider
   * path (native function-calling + provider-routing pin). When omitted, a
   * custom OpenAI-compatible provider is seeded at `baseUrl`.
   */
  id?: string;
  baseUrl?: string;
  model: string;
  apiKey?: string;
  /** OpenRouter provider-routing pin (JSON) — only honored when id === "openrouter". */
  openrouterProviderJson?: string;
}

export interface RunHeadlessOptions {
  workspaceDir: string;
  prompt: string;
  provider: HeadlessProvider;
  mode?: "build" | "ask";
  timeoutMs?: number;
  /** Resolve a registered IPC handler. Default reads the headless electron stub;
   *  the vitest test injects its own (electron is mocked there). */
  resolveHandler?: (channel: string) => Promise<HandlerFn>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (event: any, req: any) => Promise<unknown>;

export interface RunHeadlessResult {
  completed: boolean;
  lastAssistant: string | null;
}

let handlersRegistered = false;

async function defaultResolveHandler(channel: string): Promise<HandlerFn> {
  const electron = (await import("electron")) as unknown as {
    getRegisteredHandler?: (c: string) => HandlerFn | undefined;
  };
  const h = electron.getRegisteredHandler?.(channel);
  if (!h) {
    throw new Error(
      `No registered handler for "${channel}". Headless electron stub not active — run the bundled CLI or inject resolveHandler.`,
    );
  }
  return h;
}

const PROVIDER_ID = "atlarix-headless";

export async function runHeadlessAgent(
  opts: RunHeadlessOptions,
): Promise<RunHeadlessResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const mode = opts.mode ?? "build";
  const resolveHandler = opts.resolveHandler ?? defaultResolveHandler;

  // userData dir for this run's real sqlite + settings (honored by getUserDataPath).
  if (!process.env.ATLARIX_USER_DATA_DIR) {
    process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlarix-headless-ud-"),
    );
  }
  process.env.ATLARIX_HEADLESS = "1";
  // Benchmark integrity: force native function-calling (no text/XML tool shim)
  // regardless of provider wiring, so the comparison is apples-to-apples.
  process.env.ATLARIX_DISABLE_TEXT_TOOLS = "1";
  const userDataDir = process.env.ATLARIX_USER_DATA_DIR;
  fs.mkdirSync(userDataDir, { recursive: true });

  const { initializeDatabase } = await import("@/db");
  const db = initializeDatabase();
  const schema = await import("@/db/schema");
  // Resolve the ACTUAL settings dir (under vitest this is the test override, not
  // our env var) so readSettings() reads what we write.
  const { getUserDataPath } = await import("@/paths/paths");
  const settingsDir = getUserDataPath();

  // Builtin provider (e.g. "openrouter") → native path, no DB rows (BYOK key
  // lives in settings). Custom provider → seed an OpenAI-compatible row.
  const providerId = opts.provider.id ?? PROVIDER_ID;
  if (!opts.provider.id) {
    if (!opts.provider.baseUrl) {
      throw new Error("headless: custom provider requires provider.baseUrl");
    }
    await db
      .insert(schema.language_model_providers)
      .values({ id: PROVIDER_ID, name: "Atlarix Headless", api_base_url: opts.provider.baseUrl })
      .onConflictDoNothing();
    await db
      .insert(schema.language_models)
      .values({
        displayName: opts.provider.model,
        apiName: opts.provider.model,
        customProviderId: PROVIDER_ID,
      })
      .onConflictDoNothing();
  }

  // OpenRouter provider-routing pin (consumed in chat_stream_handlers).
  if (opts.provider.id === "openrouter" && opts.provider.openrouterProviderJson) {
    process.env.ATLARIX_OPENROUTER_PROVIDER_JSON = opts.provider.openrouterProviderJson;
  }

  // Seed the workspace app row at the target directory.
  const appRows = await db
    .insert(schema.apps)
    .values({ name: path.basename(opts.workspaceDir) || "headless", path: opts.workspaceDir })
    .returning({ id: schema.apps.id });
  const appId = appRows[0].id;

  // Settings: build mode + the provider/model + its key (plaintext; safeStorage
  // is unavailable headless). readSettings merges this over DEFAULT_SETTINGS.
  const settings: Record<string, unknown> = {
    selectedChatMode: mode,
    workModePreference: mode === "ask" ? "ask" : "build",
    selectedModel: { name: opts.provider.model, provider: providerId },
    hasRunBefore: true,
    telemetryConsent: "opted_out",
  };
  if (opts.provider.apiKey) {
    settings.providerSettings = {
      [providerId]: { apiKey: { value: opts.provider.apiKey } },
    };
  }
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, "user-settings.json"),
    JSON.stringify(settings, null, 2),
  );

  // Register the real handlers once (records onto the electron stub's ipcMain).
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
    await import("@/ipc/handlers/permissions/handlers");
  }

  const { createStreamTransport, getStreamTransport } = await import(
    "@/lib/chat/stream-transport"
  );
  const chatId = await createStreamTransport(appId);

  const sender = makeFakeSender();
  const chatStream = await resolveHandler("chat:stream");
  const executePermission = await resolveHandler("execute-permission");

  // Handler returns immediately (void runStream); the terminal signal is
  // chat:response:end. Auto-approve runs concurrently.
  await chatStream(sender.event, { chatId, prompt: opts.prompt });

  const endPromise = sender.waitFor(
    "chat:response:end",
    (p) => (p as { chatId?: number })?.chatId === chatId,
    timeoutMs,
  );
  const approvePromise = autoApprove({ sender, executePermission, chatId, timeoutMs });

  let completed = true;
  try {
    await Promise.all([endPromise, approvePromise]);
  } catch {
    completed = false; // timed out / hung — caller still captures partial work
  }

  const lastAssistant =
    [...(getStreamTransport(chatId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant")?.content ?? null;

  return { completed, lastAssistant };
}
