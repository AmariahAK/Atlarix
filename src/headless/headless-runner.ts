/**
 * Headless agent runner — drives the REAL `chat:stream` loop in plain Node
 * (no Electron, no UI), used by the standalone CLI (`atlarix-headless`) and the
 * benchmark adapters. Reuses prod modules; the only "test-shaped" pieces are the
 * fake sender + auto-approve, which live in src/headless (not tests/).
 *
 * Provider is a custom OpenAI-compatible endpoint (DeepSeek/Atlarix Core/Ollama)
 * resolved by `getModelClient` from a seeded DB row + settings.
 */
import { workspaceAppIdForPath } from "@/lib/workspace-app-by-path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakeSender } from "./fake-sender";
import { autoApprove } from "./auto-approve";
import { createTrajectoryWriter } from "./trajectory-writer";

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
  /**
   * The app's Deep-thinking toggle. ON dispatches at the model's own declared
   * reasoning ceiling ("max" where the vendor supports a budget channel, "high"
   * where effort tops out there); OFF is one notch below. Written explicitly rather
   * than left to DEFAULT_SETTINGS so a benchmark run records the level it used —
   * unset silently meant OFF, while every published leaderboard entry runs the
   * ceiling.
   */
  deepThinking?: boolean;
  /** /effort: a level exactly as the model lists it (wins over `deepThinking` when it lists it). */
  effort?: string;
  /**
   * Stream a JSONL trajectory of the run here (see `trajectory-writer.ts`).
   * Benchmark orchestrators convert it to their own trace format; Harbor's ATIF
   * is the reason it exists.
   */
  trajectoryFile?: string;
  /**
   * Files that come WITH the task, as if the user had attached them in the
   * app: images reach a vision model as images. The cloud agent passes the
   * files attached to a Slack request (`--attach`).
   */
  attachments?: { name: string; type: string; data: string }[];
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
  // Batch runs rewrite user-settings.json (the model, a plaintext key) and add a
  // workspace row per run. That is right for their throwaway folder and wrong
  // for a person's desktop data, which the interactive CLI shares.
  if (process.env.ATLARIX_DB_SHARED === "1") {
    throw new Error(
      "atlarix run cannot use the desktop app's data folder (ATLARIX_DB_SHARED=1). Unset it, or point ATLARIX_USER_DATA_DIR at a separate folder.",
    );
  }
  // No self-imposed deadline by default: whoever launched this owns the timeout.
  // A benchmark orchestrator already enforces one (Terminal-Bench 4.0 allows eight
  // hours), and the old 10-minute default silently capped every long task ~48x
  // early and exited 1 — which grades as a failed trial, not as a timeout anyone
  // can see. Callers that DO want a limit still pass `timeoutMs`.
  // `waitFor` special-cases a non-finite value; it must never reach `setTimeout`,
  // which clamps out-of-range delays to 1ms and would fire immediately.
  const timeoutMs = opts.timeoutMs ?? Number.POSITIVE_INFINITY;
  const mode = opts.mode ?? "build";
  const resolveHandler = opts.resolveHandler ?? defaultResolveHandler;

  // userData dir for this run's real sqlite + settings (honored by getUserDataPath).
  if (!process.env.ATLARIX_USER_DATA_DIR) {
    process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlarix-headless-ud-"),
    );
    // Only the database is throwaway: the person's rules and memory still apply.
    process.env.ATLARIX_HOME_DIR ??= path.join(os.homedir(), ".atlarix");
  }
  process.env.ATLARIX_HEADLESS = "1";
  // Benchmark integrity: force native function-calling (no text/XML tool shim)
  // regardless of provider wiring, so the comparison is apples-to-apples.
  process.env.ATLARIX_DISABLE_TEXT_TOOLS = "1";
  // Benchmark integrity, part two: no agent-memory surface. Memory would otherwise
  // let one task's notes influence a later task in the same suite — a confound that
  // silently inflates scores — and it spends prompt budget the comparison harness
  // never granted. Overridable, so a memory-specific benchmark can opt back in.
  if (!process.env.ATLARIX_MEMORY) process.env.ATLARIX_MEMORY = "off";
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
      .values({
        id: PROVIDER_ID,
        name: "Atlarix Headless",
        api_base_url: opts.provider.baseUrl,
      })
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
  if (
    opts.provider.id === "openrouter" &&
    opts.provider.openrouterProviderJson
  ) {
    process.env.ATLARIX_OPENROUTER_PROVIDER_JSON =
      opts.provider.openrouterProviderJson;
  }

  // The workspace row for the target directory: reused when the folder already
  // has one (a shared data folder), so repeated runs don't add duplicates.
  const appId = await workspaceAppIdForPath(opts.workspaceDir);

  // Settings: build mode + the provider/model + its key (plaintext; safeStorage
  // is unavailable headless). readSettings merges this over DEFAULT_SETTINGS.
  const settings: Record<string, unknown> = {
    selectedChatMode: mode,
    workModePreference: mode === "ask" ? "ask" : "build",
    selectedModel: { name: opts.provider.model, provider: providerId },
    hasRunBefore: true,
    telemetryConsent: "opted_out",
    // Always written, both states. `deepThinking` is `z.boolean().optional()` with no
    // default, so omitting it resolved to OFF — one notch below the model's ceiling.
    deepThinking: !!opts.deepThinking,
    ...(opts.effort ? { effort: opts.effort } : {}),
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

  const trajectory = opts.trajectoryFile
    ? createTrajectoryWriter(opts.trajectoryFile, {
        workspaceDir: opts.workspaceDir,
        model: opts.provider.model,
        provider: providerId,
        mode,
      })
    : undefined;

  // `process.once` + explicit removal, never a bare `process.on`: this function is
  // a library entry point called repeatedly in one process (the vitest suite calls
  // it several times per file), and a listener per call leaks until Node warns.
  const onSignal = (signal: NodeJS.Signals) => () => {
    trajectory?.recordTermination(signal);
    trajectory?.close();
    process.exit(130);
  };
  const sigterm = onSignal("SIGTERM");
  const sigint = onSignal("SIGINT");
  if (trajectory) {
    process.once("SIGTERM", sigterm);
    process.once("SIGINT", sigint);
  }

  try {
    const sender = makeFakeSender(trajectory?.onSend);
    const chatStream = await resolveHandler("chat:stream");
    const executePermission = await resolveHandler("execute-permission");

    trajectory?.recordUserText(opts.prompt);

    // Handler returns immediately (void runStream); the terminal signal is
    // chat:response:end. Auto-approve runs concurrently.
    await chatStream(sender.event, {
      chatId,
      prompt: opts.prompt,
      ...(opts.attachments?.length
        ? { attachments: opts.attachments.map((a) => ({ ...a, attachmentType: "chat-context" as const })) }
        : {}),
    });

    const endPromise = sender.waitFor(
      "chat:response:end",
      (p) => (p as { chatId?: number })?.chatId === chatId,
      timeoutMs,
    );
    const approvePromise = autoApprove({
      sender,
      executePermission,
      chatId,
      timeoutMs,
    });

    let completed = true;
    try {
      await Promise.all([endPromise, approvePromise]);
    } catch (e) {
      completed = false; // timed out / hung — caller still captures partial work
      // Say WHY. A bare completed=false left a run that ended in 100ms looking
      // identical to one that hit the deadline.
      const errors = sender.sends
        .filter((s) => s.channel === "chat:response:error")
        .map((s) => JSON.stringify(s.payload).slice(0, 500));
      console.error(
        `[atlarix-headless] run did not complete: ${e instanceof Error ? e.message : String(e)}` +
          (errors.length ? `\n  chat:response:error ${errors.join("\n  ")}` : ""),
      );
    }

    // A turn that ended on an error (no key, the provider refused, Core said
    // sign in) still ends cleanly; it is not a completed run. Counting it as
    // one made the cloud action report "no changes" for a run that never
    // reached the model.
    const turnErrors = sender.sends.filter((s) => s.channel === "chat:response:error");
    if (completed && turnErrors.length) {
      completed = false;
      console.error(
        `[atlarix-headless] the run ended on an error:\n  ${turnErrors.map((s) => JSON.stringify(s.payload).slice(0, 500)).join("\n  ")}`,
      );
    }

    trajectory?.recordRunEnd(completed);

    const lastAssistant =
      [...(getStreamTransport(chatId)?.messages ?? [])]
        .reverse()
        .find((m) => m.role === "assistant")?.content ?? null;

    return { completed, lastAssistant };
  } finally {
    process.removeListener("SIGTERM", sigterm);
    process.removeListener("SIGINT", sigint);
    trajectory?.close();
  }
}
