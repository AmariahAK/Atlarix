import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import { ChildProcess, spawn } from "child_process";
import type { WebContents } from "electron";
import * as fs from "fs";
import log from "electron-log";
import {
  LspServerConfig,
  findServerForWorkspace,
  findNearestRoot,
  getLanguageFromFile,
  resolveServerCommand,
} from "./lsp-server-registry";

const logger = log.scope("lsp-client");

const DIAGNOSTICS_DEBOUNCE_MS = 150;
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000;

interface LspClient {
  serverId: string;
  root: string;
  process: ChildProcess;
  connection: ReturnType<typeof createMessageConnection>;
  pushDiagnostics: Map<string, Diagnostic[]>;
  pullDiagnostics: Map<string, Diagnostic[]>;
  published: Map<string, { at: number; version?: number }>;
  broken: boolean;
}

export type { LspClient };

const lspClients = new Map<string, LspClient>();
const spawning = new Map<string, Promise<LspClient | null>>();
const brokenServers = new Set<string>();
const lspPushSubscribers = new Map<number, { webContents: WebContents; workspaceRoot: string }>();
const documentVersions = new Map<string, number>();

function documentVersionKey(workspaceRoot: string, filePath: string): string {
  return `${workspaceRoot}::${filePath}`;
}

function nextDocumentVersion(workspaceRoot: string, filePath: string): number {
  const key = documentVersionKey(workspaceRoot, filePath);
  const version = (documentVersions.get(key) ?? 0) + 1;
  documentVersions.set(key, version);
  return version;
}

export function subscribeLspPush(webContents: WebContents, workspaceRoot: string): void {
  lspPushSubscribers.set(webContents.id, { webContents, workspaceRoot });
}

export function unsubscribeLspPush(webContents: WebContents): void {
  lspPushSubscribers.delete(webContents.id);
}

function pushDiagnosticsToRenderer(
  workspaceRoot: string,
  filePath: string,
  diagnostics: Diagnostic[],
): void {
  const payload = { workspaceRoot, filePath, diagnostics };
  for (const sub of lspPushSubscribers.values()) {
    if (sub.workspaceRoot !== workspaceRoot) continue;
    if (sub.webContents.isDestroyed()) continue;
    sub.webContents.send("lsp:diagnostics", payload);
  }
}

function getClientKey(workspaceRoot: string, serverId: string): string {
  return `${workspaceRoot}::${serverId}`;
}

function getFilePath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    const url = new URL(uri);
    return url.pathname;
  } catch {
    return undefined;
  }
}

function shouldSeedDiagnosticsOnFirstPush(serverID: string): boolean {
  return serverID === "typescript";
}

export async function getOrCreateClient(
  filePath: string,
  workspaceRoot: string,
  language: string
): Promise<LspClient | null> {
  const config = await findServerForWorkspace(workspaceRoot, language);
  if (!config) {
    const quiet =
      language === "plaintext" ||
      language === "markdown" ||
      language === "atlarix-text";
    if (quiet) {
      logger.debug(`No LSP server for language: ${language}`);
    } else {
      logger.info(`No LSP server found for language: ${language}`);
    }
    return null;
  }

  const cacheKey = `${workspaceRoot}::${config.id}`;
  const existing = lspClients.get(cacheKey);
  if (existing && !existing.broken) {
    return existing;
  }

  if (brokenServers.has(cacheKey)) {
    return null;
  }

  const inflight = spawning.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const task = createClient(filePath, workspaceRoot, config);
  spawning.set(cacheKey, task);

  task.finally(() => {
    if (spawning.get(cacheKey) === task) {
      spawning.delete(cacheKey);
    }
  });

  return task;
}

async function createClient(
  filePath: string,
  workspaceRoot: string,
  config: LspServerConfig
): Promise<LspClient | null> {
  const cacheKey = getClientKey(workspaceRoot, config.id);
  const resolved = await resolveServerCommand(config, workspaceRoot);
  if (!resolved) {
    logger.info(`LSP binary not available for ${config.id}`);
    brokenServers.add(cacheKey);
    return null;
  }

  let proc: ChildProcess;
  try {
    proc = spawn(resolved.command, resolved.args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: resolved.env,
    });
  } catch (err) {
    logger.error(`Failed to spawn LSP server: ${config.id}`, err);
    brokenServers.add(cacheKey);
    return null;
  }

  if (!proc.stdout || !proc.stdin) {
    logger.error(`LSP process stdout/stdin not available`);
    return null;
  }

  const connection = createMessageConnection(
    new StreamMessageReader(proc.stdout),
    new StreamMessageWriter(proc.stdin)
  );

  const client: LspClient = {
    serverId: config.id,
    root: workspaceRoot,
    process: proc,
    connection,
    pushDiagnostics: new Map(),
    pullDiagnostics: new Map(),
    published: new Map(),
    broken: false,
  };

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const filePath = getFilePath(params.uri);
    if (!filePath) return;

    logger.info("textDocument/publishDiagnostics", {
      path: filePath,
      count: params.diagnostics.length,
      version: params.version,
    });

    client.published.set(filePath, {
      at: Date.now(),
      version: typeof params.version === "number" ? params.version : undefined,
    });

    if (shouldSeedDiagnosticsOnFirstPush(config.id) && !client.pushDiagnostics.has(filePath)) {
      client.pushDiagnostics.set(filePath, params.diagnostics);
      return;
    }

    client.pushDiagnostics.set(filePath, params.diagnostics);
    pushDiagnosticsToRenderer(workspaceRoot, filePath, params.diagnostics);
  });

  connection.onNotification("window/logMessage", (params) => {
    logger.debug(`[${config.id}] ${params.message}`);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      logger.debug(`[${config.id}] stderr: ${text.slice(0, 500)}`);
    }
  });

  proc.on("error", (err) => {
    logger.error(`LSP process error for ${config.id}:`, err);
    client.broken = true;
    brokenServers.add(cacheKey);
  });

  proc.on("exit", (code, signal) => {
    logger.info(`LSP process exited: ${config.id}, code: ${code}, signal: ${signal}`);
    client.broken = true;
    brokenServers.add(cacheKey);
  });

  connection.listen();

  try {
    const rootPath = findNearestRoot(filePath, workspaceRoot, config.rootMarkers);

    await connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: `file://${rootPath}`,
      rootPath: rootPath,
      workspaceFolders: [{ uri: `file://${workspaceRoot}`, name: "workspace" }],
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
          synchronization: {},
          hover: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
        },
        workspace: {},
      },
    });

    connection.sendNotification("initialized", {});

    logger.info(`LSP client created: ${config.id} for ${workspaceRoot}`);
    lspClients.set(`${workspaceRoot}::${config.id}`, client);
    return client;
  } catch (err) {
    logger.error(`Failed to initialize LSP client: ${config.id}`, err);
    brokenServers.add(cacheKey);
    connection.dispose();
    proc.kill();
    return null;
  }
}

export async function notifyFileOpen(
  filePath: string,
  workspaceRoot: string,
  options?: { content?: string; version?: number },
): Promise<void> {
  const language = getLanguageFromFile(filePath);
  const client = await getOrCreateClient(filePath, workspaceRoot, language);
  if (!client || client.broken) return;

  try {
    const content = options?.content ?? fs.readFileSync(filePath, "utf-8");
    const languageId = language === "plaintext" ? "plaintext" : language;
    const version =
      options?.version ?? nextDocumentVersion(workspaceRoot, filePath);

    client.connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: `file://${filePath}`,
        languageId,
        version,
        text: content,
      },
    });
  } catch (err) {
    logger.error(`Failed to send didOpen for ${filePath}:`, err);
  }
}

export async function notifyFileChange(
  filePath: string,
  workspaceRoot: string,
  options?: { content?: string; version?: number },
): Promise<void> {
  const language = getLanguageFromFile(filePath);
  const client = await getOrCreateClient(filePath, workspaceRoot, language);
  if (!client || client.broken) return;

  try {
    const content = options?.content ?? fs.readFileSync(filePath, "utf-8");
    const version =
      options?.version ?? nextDocumentVersion(workspaceRoot, filePath);

    client.connection.sendNotification("textDocument/didChange", {
      textDocument: {
        uri: `file://${filePath}`,
        version,
      },
      contentChanges: [{ text: content }],
    });
  } catch (err) {
    logger.error(`Failed to send didChange for ${filePath}:`, err);
  }
}

export async function notifyFileClose(
  filePath: string,
  workspaceRoot: string,
): Promise<void> {
  const language = getLanguageFromFile(filePath);
  const client = await getOrCreateClient(filePath, workspaceRoot, language);
  if (!client || client.broken) return;

  try {
    client.connection.sendNotification("textDocument/didClose", {
      textDocument: { uri: `file://${filePath}` },
    });
    client.pushDiagnostics.delete(filePath);
    client.published.delete(filePath);
    documentVersions.delete(documentVersionKey(workspaceRoot, filePath));
    pushDiagnosticsToRenderer(workspaceRoot, filePath, []);
  } catch (err) {
    logger.error(`Failed to send didClose for ${filePath}:`, err);
  }
}

export async function waitForDiagnostics(
  client: LspClient,
  filePath: string,
  mode: "document" | "full" = "document",
  timeoutMs: number = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS
): Promise<Diagnostic[]> {
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    let debounceTimer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(debounceTimer);
    };

    timeout = setTimeout(() => {
      cleanup();
      const cached = client.pushDiagnostics.get(filePath) || [];
      resolve(cached);
    }, timeoutMs);

    const checkAndResolve = () => {
      const published = client.published.get(filePath);
      if (published) {
        debounceTimer = setTimeout(() => {
          cleanup();
          const cached = client.pushDiagnostics.get(filePath) || [];
          resolve(cached);
        }, DIAGNOSTICS_DEBOUNCE_MS);
      }
    };

    checkAndResolve();
  });
}

export async function ensureDocumentSyncedForLsp(
  filePath: string,
  workspaceRoot: string,
): Promise<LspClient | null> {
  await notifyFileOpen(filePath, workspaceRoot);
  await notifyFileChange(filePath, workspaceRoot);
  const language = getLanguageFromFile(filePath);
  return getOrCreateClient(filePath, workspaceRoot, language);
}

export async function requestLspDiagnosticsAfterSync(
  filePath: string,
  workspaceRoot: string,
): Promise<Diagnostic[]> {
  const client = await ensureDocumentSyncedForLsp(filePath, workspaceRoot);
  if (!client || client.broken) return [];
  try {
    return await waitForDiagnostics(client, filePath, "document", DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS);
  } catch (err) {
    logger.error(`Failed to pull diagnostics for ${filePath}:`, err);
    void import("@sentry/electron/main")
      .then((Sentry) => {
        Sentry.addBreadcrumb({
          category: "lsp",
          message: "lsp_diagnostics_failed",
          level: "warning",
          data: { filePath },
        });
      })
      .catch(() => {});
    return client.pushDiagnostics.get(filePath) ?? [];
  }
}

export async function requestLspHover(
  filePath: string,
  workspaceRoot: string,
  line: number,
  character: number,
): Promise<unknown | null> {
  const client = await ensureDocumentSyncedForLsp(filePath, workspaceRoot);
  if (!client || client.broken) return null;
  try {
    return await client.connection.sendRequest("textDocument/hover", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    });
  } catch (err) {
    logger.error(`Failed to request hover for ${filePath}:`, err);
    void import("@sentry/electron/main")
      .then((Sentry) => {
        Sentry.addBreadcrumb({
          category: "lsp",
          message: "lsp_hover_failed",
          level: "warning",
          data: { filePath, line, character },
        });
      })
      .catch(() => {});
    return null;
  }
}

export async function requestLspDefinition(
  filePath: string,
  workspaceRoot: string,
  line: number,
  character: number,
): Promise<unknown | null> {
  const client = await ensureDocumentSyncedForLsp(filePath, workspaceRoot);
  if (!client || client.broken) return null;
  try {
    return await client.connection.sendRequest("textDocument/definition", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    });
  } catch (err) {
    logger.error(`Failed to request definition for ${filePath}:`, err);
    void import("@sentry/electron/main")
      .then((Sentry) => {
        Sentry.addBreadcrumb({
          category: "lsp",
          message: "lsp_definition_failed",
          level: "warning",
          data: { filePath, line, character },
        });
      })
      .catch(() => {});
    return null;
  }
}

export async function requestLspReferences(
  filePath: string,
  workspaceRoot: string,
  line: number,
  character: number,
): Promise<unknown | null> {
  const client = await ensureDocumentSyncedForLsp(filePath, workspaceRoot);
  if (!client || client.broken) return null;
  try {
    return await client.connection.sendRequest("textDocument/references", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
      context: { includeDeclaration: true },
    });
  } catch (err) {
    logger.error(`Failed to request references for ${filePath}:`, err);
    void import("@sentry/electron/main")
      .then((Sentry) => {
        Sentry.addBreadcrumb({
          category: "lsp",
          message: "lsp_references_failed",
          level: "warning",
          data: { filePath, line, character },
        });
      })
      .catch(() => {});
    return null;
  }
}

