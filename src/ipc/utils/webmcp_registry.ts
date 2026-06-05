/**
 * WebMCP registry (v11) — main-process view of tools that pages in the in-app
 * browser registered via the W3C draft `navigator.modelContext` API (shimmed
 * in preload-browser.ts; Electron's Chromium does not ship it).
 *
 * Only metadata lives here; `execute` closures stay in page context and are
 * invoked over an IPC round-trip with a hard timeout — a hostile page must
 * never hang the chat stream. All descriptions/results are untrusted input.
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { getActiveTabView } from "./browser_view_manager";

const logger = log.scope("webmcp");

export type WebMcpToolMeta = {
  name: string;
  description: string;
  title?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
};

const EXECUTE_TIMEOUT_MS = 20_000;
const MAX_TOOLS_PER_PAGE = 64;
const MAX_RESULT_CHARS = 200_000;

/** tabId → tools registered by the current document in that tab. */
const toolsByTab = new Map<number, { origin: string; tools: WebMcpToolMeta[] }>();

let nextCallId = 1;
const pendingCalls = new Map<
  number,
  { resolve: (v: { ok: boolean; result?: string; error?: string }) => void; timer: NodeJS.Timeout }
>();

function tabIdOf(sender: Electron.WebContents): number | null {
  const id = (sender as Electron.WebContents & { __atlarixTabId?: number }).__atlarixTabId;
  return typeof id === "number" ? id : null;
}

function originOf(sender: Electron.WebContents): string {
  try {
    return new URL(sender.getURL()).origin;
  } catch {
    return "unknown-origin";
  }
}

export function registerWebMcpIpc(): void {
  ipcMain.on("webmcp:tools-changed", (event, toolsJson: string) => {
    const tabId = tabIdOf(event.sender);
    if (tabId == null) return;
    try {
      const parsed = JSON.parse(String(toolsJson)) as WebMcpToolMeta[];
      if (!Array.isArray(parsed)) return;
      const tools = parsed
        .filter(
          (t) =>
            t &&
            typeof t.name === "string" &&
            /^[a-zA-Z0-9_.-]{1,128}$/.test(t.name) &&
            typeof t.description === "string",
        )
        .slice(0, MAX_TOOLS_PER_PAGE)
        .map((t) => ({
          name: t.name,
          description: String(t.description).slice(0, 4096),
          title: typeof t.title === "string" ? t.title.slice(0, 256) : undefined,
          inputSchema: t.inputSchema,
          annotations:
            t.annotations && typeof t.annotations === "object"
              ? {
                  readOnlyHint: Boolean(t.annotations.readOnlyHint),
                  untrustedContentHint: Boolean(t.annotations.untrustedContentHint),
                }
              : undefined,
        }));
      toolsByTab.set(tabId, { origin: originOf(event.sender), tools });
      logger.log(`[webmcp] tab ${tabId}: ${tools.length} tool(s) from ${originOf(event.sender)}`);
    } catch (err) {
      logger.warn("[webmcp] bad tools-changed payload", err);
    }
  });

  ipcMain.on(
    "webmcp:execute-result",
    (_event, payload: { callId: number; ok: boolean; resultJson?: string; error?: string }) => {
      const pending = pendingCalls.get(payload?.callId);
      if (!pending) return;
      pendingCalls.delete(payload.callId);
      clearTimeout(pending.timer);
      pending.resolve(
        payload.ok
          ? { ok: true, result: String(payload.resultJson ?? "null").slice(0, MAX_RESULT_CHARS) }
          : { ok: false, error: String(payload.error ?? "Tool execution failed").slice(0, 4096) },
      );
    },
  );

  logger.log("[webmcp] IPC registered");
}

export function clearToolsForTab(tabId: number): void {
  if (toolsByTab.delete(tabId)) {
    logger.log(`[webmcp] tab ${tabId}: tools cleared (navigation/close)`);
  }
}

/** Tools registered by the page in the ACTIVE browser tab (empty when none). */
export function listActiveWebMcpTools(): { origin: string; tools: WebMcpToolMeta[] } | null {
  const view = getActiveTabView();
  if (!view) return null;
  const tabId = (view.webContents as Electron.WebContents & { __atlarixTabId?: number })
    .__atlarixTabId;
  if (typeof tabId !== "number") return null;
  return toolsByTab.get(tabId) ?? null;
}

export async function callActiveWebMcpTool(
  name: string,
  input: unknown,
): Promise<{ ok: boolean; origin: string; result?: string; error?: string }> {
  const view = getActiveTabView();
  const entry = listActiveWebMcpTools();
  if (!view || !entry) {
    return { ok: false, origin: "none", error: "No browser page with WebMCP tools is open." };
  }
  if (!entry.tools.some((t) => t.name === name)) {
    return {
      ok: false,
      origin: entry.origin,
      error: `Tool "${name}" is not registered by the current page. Available: ${entry.tools.map((t) => t.name).join(", ") || "(none)"}`,
    };
  }

  const callId = nextCallId++;
  const resultPromise = new Promise<{ ok: boolean; result?: string; error?: string }>(
    (resolve) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(callId);
        resolve({ ok: false, error: `WebMCP tool timed out after ${EXECUTE_TIMEOUT_MS / 1000}s.` });
      }, EXECUTE_TIMEOUT_MS);
      pendingCalls.set(callId, { resolve, timer });
    },
  );
  view.webContents.send("webmcp:execute", {
    callId,
    name,
    inputJson: JSON.stringify(input ?? {}),
  });
  const outcome = await resultPromise;
  return { ...outcome, origin: entry.origin };
}
