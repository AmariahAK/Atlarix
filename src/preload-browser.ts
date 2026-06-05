/**
 * Browser-tab preload (v11) — runs sandboxed + context-isolated inside the
 * in-app browser's WebContentsView. Two jobs:
 *
 * 1. WebMCP shim: Electron's Chromium doesn't ship the W3C draft
 *    `navigator.modelContext`, so we install a main-world polyfill. Tool
 *    metadata is relayed to the main process; `execute` closures stay in the
 *    page world and are invoked via a proxied callback.
 * 2. Execute relay: main → `webmcp:execute` → page-world executor →
 *    `webmcp:execute-result`. Errors/timeouts are the main process's job.
 *
 * Everything a page hands us is untrusted — metadata is serialized through
 * JSON and length-capped again main-side.
 */

import { contextBridge, ipcRenderer, webFrame } from "electron";

type PageExecutor = (name: string, inputJson: string) => Promise<string>;

let pageExecutor: PageExecutor | null = null;

contextBridge.exposeInMainWorld("__atlarixWebMCP", {
  toolsChanged: (toolsJson: string) => {
    if (typeof toolsJson === "string" && toolsJson.length < 512_000) {
      ipcRenderer.send("webmcp:tools-changed", toolsJson);
    }
  },
  setExecutor: (executor: PageExecutor) => {
    pageExecutor = executor;
  },
});

ipcRenderer.on(
  "webmcp:execute",
  async (_event, payload: { callId: number; name: string; inputJson: string }) => {
    const { callId, name, inputJson } = payload ?? {};
    try {
      if (!pageExecutor) throw new Error("No WebMCP tools registered on this page");
      const resultJson = await pageExecutor(String(name), String(inputJson));
      ipcRenderer.send("webmcp:execute-result", {
        callId,
        ok: true,
        resultJson: typeof resultJson === "string" ? resultJson : "null",
      });
    } catch (err) {
      ipcRenderer.send("webmcp:execute-result", {
        callId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * Main-world polyfill. Implements the draft surface: registerTool,
 * unregisterTool, provideContext, clearContext, `toolchange` event. Tools are
 * cleared automatically on navigation (each document gets a fresh shim).
 */
const MAIN_WORLD_SHIM = String.raw`(() => {
  if (navigator.modelContext) return; // future Chromium may ship it natively
  const bridge = window.__atlarixWebMCP;
  if (!bridge) return;
  const tools = new Map();
  const target = new EventTarget();

  function metaOf(tool) {
    return {
      name: String(tool.name),
      description: String(tool.description ?? ""),
      title: tool.title != null ? String(tool.title) : undefined,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    };
  }
  function publish() {
    try {
      bridge.toolsChanged(JSON.stringify([...tools.values()].map(metaOf)));
    } catch (_) { /* metadata not serializable */ }
    target.dispatchEvent(new Event("toolchange"));
  }
  function validName(name) {
    return typeof name === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(name);
  }
  function registerTool(tool, options) {
    if (!tool || !validName(tool.name) || typeof tool.execute !== "function") {
      throw new TypeError("WebMCP tool requires a valid name and an execute() function");
    }
    tools.set(tool.name, tool);
    if (options && options.signal && typeof options.signal.addEventListener === "function") {
      options.signal.addEventListener("abort", () => {
        tools.delete(tool.name);
        publish();
      });
    }
    publish();
  }

  const client = {
    requestUserInteraction: async () => false, // not supported by the embedder yet
  };

  bridge.setExecutor(async (name, inputJson) => {
    const tool = tools.get(name);
    if (!tool) throw new Error("Unknown WebMCP tool: " + name);
    const input = inputJson ? JSON.parse(inputJson) : {};
    const result = await tool.execute(input, client);
    return JSON.stringify(result === undefined ? null : result);
  });

  const modelContext = {
    registerTool,
    unregisterTool(name) {
      if (tools.delete(name)) publish();
    },
    provideContext(context) {
      tools.clear();
      const list = context && Array.isArray(context.tools) ? context.tools : [];
      for (const tool of list) {
        if (tool && validName(tool.name) && typeof tool.execute === "function") {
          tools.set(tool.name, tool);
        }
      }
      publish();
    },
    clearContext() {
      tools.clear();
      publish();
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  Object.defineProperty(modelContext, "ontoolchange", {
    set(handler) {
      target.addEventListener("toolchange", handler);
    },
  });

  try {
    Object.defineProperty(Navigator.prototype, "modelContext", {
      value: modelContext,
      configurable: true,
    });
  } catch (_) {
    navigator.modelContext = modelContext;
  }
  // Earlier spec drafts hung the API off document; keep an alias for sites
  // written against those.
  try {
    Object.defineProperty(Document.prototype, "modelContext", {
      value: modelContext,
      configurable: true,
    });
  } catch (_) { /* best effort */ }
})();`;

void webFrame.executeJavaScript(MAIN_WORLD_SHIM).catch(() => {
  // CSP-restricted pages may refuse eval-style injection; WebMCP is simply
  // unavailable there.
});
