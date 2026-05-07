import { notifyFileOpen, notifyFileChange, waitForDiagnostics, getActiveClients } from "./lsp-client";
import { getLanguageFromFile } from "./lsp-server-registry";
import log from "electron-log";

const logger = log.scope("lsp-trigger");

let currentWorkMode: "ask" | "plan" | "build" | "debug" | "review" = "ask";
let currentWorkspaceRoot: string | null = null;

export function setWorkMode(mode: "ask" | "plan" | "build" | "debug" | "review"): void {
  currentWorkMode = mode;
}

export function setWorkspaceRoot(root: string | null): void {
  currentWorkspaceRoot = root;
  if (!root) {
  }
}

export async function touchFile(filePath: string): Promise<void> {
  if (!currentWorkspaceRoot) return;

  const shouldTrigger =
    currentWorkMode === "build" || currentWorkMode === "debug";

  if (!shouldTrigger) return;

  const language = getLanguageFromFile(filePath);
  if (language === "plaintext") return;

  try {
    await notifyFileOpen(filePath, currentWorkspaceRoot);

    const clients = getActiveClients(currentWorkspaceRoot);
    if (clients.length === 0) return;

    const mode = currentWorkMode === "debug" ? "full" : "document";

    await Promise.all(
      clients.map(async (client) => {
        if (client.pushDiagnostics.has(filePath)) {
          await waitForDiagnostics(client, filePath, mode, 5000);
        }
      })
    );
  } catch (err) {
    logger.error(`Error in touchFile for ${filePath}:`, err);
  }
}

export async function onFileSaved(filePath: string): Promise<void> {
  if (!currentWorkspaceRoot) return;

  const shouldTrigger =
    currentWorkMode === "build" || currentWorkMode === "debug";

  if (!shouldTrigger) return;

  const language = getLanguageFromFile(filePath);
  if (language === "plaintext") return;

  try {
    await notifyFileChange(filePath, currentWorkspaceRoot);
  } catch (err) {
    logger.error(`Error in onFileSaved for ${filePath}:`, err);
  }
}

export async function onFileChanged(filePath: string): Promise<void> {
  if (!currentWorkspaceRoot) return;

  const shouldTrigger =
    currentWorkMode === "build" || currentWorkMode === "debug";

  if (!shouldTrigger) return;

  const language = getLanguageFromFile(filePath);
  if (language === "plaintext") return;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(async () => {
    try {
      await notifyFileChange(filePath, currentWorkspaceRoot!);
    } catch (err) {
      logger.error(`Error in onFileChanged debounce for ${filePath}:`, err);
    }
  }, 150);
}

export function isLspAvailable(): boolean {
  return currentWorkMode === "build" || currentWorkMode === "debug";
}

export function getCurrentWorkMode(): string {
  return currentWorkMode;
}

export function getWorkspaceRoot(): string | null {
  return currentWorkspaceRoot;
}