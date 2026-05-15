import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import log from "electron-log";
import {
  LspServerConfig,
  findServerForWorkspace,
  findNearestRoot,
  getLanguageFromFile,
  checkBinaryAvailable,
} from "./lsp-server-registry";

const logger = log.scope("lsp-client");

const DIAGNOSTICS_DEBOUNCE_MS = 150;
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000;
const INITIALIZE_TIMEOUT_MS = 45_000;

const FILE_CHANGE_CREATED = 1;
const FILE_CHANGE_CHANGED = 2;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;

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

import { publishAgentMessage, type AgentId } from "@/lib/agents/agent-bus";

export const LspEvent = {
  Diagnostics: "lsp.client.diagnostics",
} as const;

type DiagnosticsPayload = {
  serverID: string;
  path: string;
};

const lspClients = new Map<string, LspClient>();
const spawning = new Map<string, Promise<LspClient | null>>();
const brokenServers = new Set<string>();

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

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    logger.info(`No LSP server found for language: ${language}`);
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
  const binaryPath = config.command[0];
  const args = config.command.slice(1);
  const binaryAvailable = await checkBinaryAvailable(binaryPath, workspaceRoot);
  if (!binaryAvailable) {
    logger.info(`LSP binary not available: ${binaryPath}`);
    return null;
  }

  let proc: ChildProcess;
  try {
    proc = spawn(binaryPath, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (err) {
    logger.error(`Failed to spawn LSP server: ${binaryPath}`, err);
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
    publishAgentMessage({
      from: "main" as AgentId,
      to: "main" as AgentId,
      type: "status",
      payload: { serverID: config.id, path: filePath, diagnostics: params.diagnostics },
      content: `LSP diagnostics: ${params.diagnostics.length} for ${filePath}`,
    });
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
  });

  proc.on("exit", (code, signal) => {
    logger.info(`LSP process exited: ${config.id}, code: ${code}, signal: ${signal}`);
    client.broken = true;
  });

  try {
    const rootPath = findNearestRoot(filePath, workspaceRoot, config.rootMarkers);

    const initializeResult = await connection.sendRequest("initialize", {
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
    connection.dispose();
    proc.kill();
    return null;
  }
}

export async function notifyFileOpen(filePath: string, workspaceRoot: string): Promise<void> {
  const language = getLanguageFromFile(filePath);
  const client = await getOrCreateClient(filePath, workspaceRoot, language);
  if (!client || client.broken) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const languageId = language === "plaintext" ? "plaintext" : language;

    client.connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: `file://${filePath}`,
        languageId,
        version: 0,
        text: content,
      },
    });
  } catch (err) {
    logger.error(`Failed to send didOpen for ${filePath}:`, err);
  }
}

export async function notifyFileChange(filePath: string, workspaceRoot: string): Promise<void> {
  const language = getLanguageFromFile(filePath);
  const client = await getOrCreateClient(filePath, workspaceRoot, language);
  if (!client || client.broken) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");

    client.connection.sendNotification("textDocument/didChange", {
      textDocument: {
        uri: `file://${filePath}`,
        version: (client.pushDiagnostics.get(filePath)?.length ?? 0) + 1,
      },
      contentChanges: [{ text: content }],
    });
  } catch (err) {
    logger.error(`Failed to send didChange for ${filePath}:`, err);
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

export async function requestCodeAction(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot: string
): Promise<Array<{ title: string; command: string; arguments?: unknown[] }> | null> {
  const language = getLanguageFromFile(filePath);
  const client = await getOrCreateClient(filePath, workspaceRoot, language);
  if (!client || client.broken) return null;

  try {
    const result = await client.connection.sendRequest("textDocument/codeAction", {
      textDocument: { uri: `file://${filePath}` },
      range: {
        start: { line, character },
        end: { line, character },
      },
      context: { diagnostics: client.pushDiagnostics.get(filePath) || [] },
    });

    if (!result || !Array.isArray(result)) return null;

    return result.map((item: any) => ({
      title: item.title,
      command: item.command,
      arguments: item.arguments,
    }));
  } catch (err) {
    logger.error(`Failed to request code action for ${filePath}:`, err);
    return null;
  }
}

export async function applyWorkspaceEdit(
  filePath: string,
  workspaceRoot: string,
  edit: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }
): Promise<boolean> {
  const language = getLanguageFromFile(filePath);
  const client = await getOrCreateClient(filePath, workspaceRoot, language);
  if (!client || client.broken) return false;

  try {
    await client.connection.sendRequest("workspace/applyEdit", {
      edit: {
        documentChanges: [
          {
            textDocument: { uri: `file://${filePath}`, version: 0 },
            edits: [{ range: edit.range, newText: edit.newText }],
          },
        ],
      },
    });
    return true;
  } catch (err) {
    logger.error(`Failed to apply workspace edit for ${filePath}:`, err);
    return false;
  }
}

export function getActiveClients(workspaceRoot: string): LspClient[] {
  const clients: LspClient[] = [];
  for (const [key, client] of lspClients) {
    if (key.startsWith(`${workspaceRoot}::`) && !client.broken) {
      clients.push(client);
    }
  }
  return clients;
}

export function closeClientsForWorkspace(workspaceRoot: string): void {
  for (const [key, client] of lspClients) {
    if (key.startsWith(`${workspaceRoot}::`)) {
      try {
        client.connection.sendRequest("shutdown", {}).catch(() => {});
        client.connection.sendNotification("exit", {});
        client.process.kill();
      } catch {
      }
      lspClients.delete(key);
    }
  }

  for (const key of brokenServers) {
    if (key.startsWith(`${workspaceRoot}::`)) {
      brokenServers.delete(key);
    }
  }
}

export function clearBrokenServers(): void {
  brokenServers.clear();
}