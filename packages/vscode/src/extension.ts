/**
 * Atlarix for VS Code and the editors built on it (Cursor, Kiro, Windsurf…).
 *
 * The agent is the Atlarix CLI running as `atlarix acp`; this extension is its
 * window: a chat in the side bar (or an editor tab), edits shown in the
 * editor's own diff, and the editor's selection and files as context.
 */
import path from "node:path";
import {
  CONSENT_ASKED_KEY,
  CONSENT_DETAIL,
  CONSENT_QUESTION,
  DETAILS,
  HOST_ERROR_KEY,
  NO,
  YES,
  agentTelemetryEnv,
  consentFor,
  shouldAskConsent,
} from "./consent";
import * as vscode from "vscode";
import { findAtlarix } from "./binary";
import { Chat, type ChatHost } from "./chat";
import { AtlarixConnection } from "./connection";
import { DIFF_SCHEME, DiffDocuments } from "./diff";
import { chatHtml } from "./html";
import type { ContextItem, HostSettings } from "./protocol";
import { problemsText } from "./problems";

let connection: AtlarixConnection | null = null;
let starting: Promise<AtlarixConnection | null> | null = null;
/** Why the last start failed, for the chat's "Atlarix couldn't start: …" (null once one starts). */
let startError: string | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Atlarix");
  /**
   * Usage analytics, asked once: the editor never asked, so an editor user
   * sent nothing at all. The answer is the app's and the CLI's setting too.
   */
  const askAnalyticsConsent = async (c: AtlarixConnection): Promise<void> => {
    try {
      const { consent } = await c.analyticsConsent();
      const askedHere = context.globalState.get<boolean>(CONSENT_ASKED_KEY) === true;
      if (!shouldAskConsent(consent, askedHere, vscode.env.isTelemetryEnabled)) return;
      await context.globalState.update(CONSENT_ASKED_KEY, true);
      let pick = await vscode.window.showInformationMessage(CONSENT_QUESTION, YES, NO, DETAILS);
      if (pick === DETAILS) {
        pick = await vscode.window.showInformationMessage("Help improve Atlarix", { modal: true, detail: CONSENT_DETAIL }, YES, NO);
      }
      const answer = consentFor(pick);
      if (answer) await c.setAnalyticsConsent(answer);
    } catch (e) {
      log.appendLine(`Analytics question skipped: ${(e as Error).message}`);
    }
  };

  // VS Code's telemetry switch, changed while the agent runs: it stops (or
  // resumes) the agent's analytics and crash reports at once.
  context.subscriptions.push(
    vscode.env.onDidChangeTelemetryEnabled((on) => {
      if (connection?.alive) void connection.setHostTelemetry(on).catch(() => {});
    }),
  );

  const diffs = new DiffDocuments();
  const chats = new Set<Chat>();
  let sidebar: Chat | null = null;
  let lastActive: Chat | null = null;
  /** The sign-in under way, and the page the CLI opened for it. */
  let signingIn: Promise<void> | null = null;
  let signInUrl: string | null = null;
  const version = String(context.extension.packageJSON.version ?? "0.0.0");

  const workspace = (): string | null => {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    return (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath ?? null;
  };

  const connect = async (): Promise<AtlarixConnection | null> => {
    if (connection?.alive) return connection;
    if (starting) return starting;
    starting = (async () => {
      const found = findAtlarix(context.extensionPath, vscode.workspace.getConfiguration("atlarix").get<string>("cliPath"));
      if (found.binary === null) {
        // Reported by the next run that starts (a word, never the path).
        void context.globalState.update(HOST_ERROR_KEY, found.badSetting ? "cli_path_unusable" : "cli_not_found");
        if (found.badSetting) {
          startError = `atlarix.cliPath can't be run (${found.badSetting})`;
          void vscode.window
            .showErrorMessage(`Atlarix can't run atlarix.cliPath: ${found.badSetting}`, "Open Settings")
            .then((go) => go && vscode.commands.executeCommand("workbench.action.openSettings", "atlarix.cliPath"));
          return null;
        }
        startError = "its agent program wasn't found. Reinstall the extension, or install the CLI (npm i -g atlarix).";
        void vscode.window
          .showErrorMessage("Atlarix couldn't find its agent program. Reinstall the extension, or install the CLI (npm i -g atlarix).", "Get Atlarix")
          .then((go) => go && vscode.env.openExternal(vscode.Uri.parse("https://atlarix.dev/download")));
        return null;
      }
      const binary = found.binary;
      log.appendLine(`Starting ${binary} acp`);
      const c = new AtlarixConnection({
        binary,
        cwd: workspace() ?? path.dirname(binary),
        version,
        editor: vscode.env.appName,
        telemetryEnv: agentTelemetryEnv(vscode.env.isTelemetryEnabled, context.globalState.get<string>(HOST_ERROR_KEY)),
        log: (l) => log.appendLine(l),
        openUrl: (u, kind) => {
          // The agent opens its sign-in page in your browser itself; opening it
          // here too asked "Do you want Code to open the external website?"
          // after the page was already up (owner). Kept for the fallback below.
          if (kind === "sign-in") {
            signInUrl = u;
            return;
          }
          void vscode.env.openExternal(vscode.Uri.parse(u));
        },
        onExit: (code) => {
          log.appendLine(`Atlarix exited (${code})`);
          if (connection === c) connection = null;
        },
        openSession: (sessionId) => openSessionHere(sessionId),
      });
      try {
        await c.start();
        connection = c;
        startError = null;
        // Reported by this run (session_started), so forget it.
        void context.globalState.update(HOST_ERROR_KEY, undefined);
        void askAnalyticsConsent(c);
        return c;
      } catch (e) {
        log.appendLine(`Couldn't start Atlarix: ${(e as Error).message}`);
        startError = (e as Error).message;
        void context.globalState.update(HOST_ERROR_KEY, "start_failed");
        c.dispose();
        void vscode.window.showErrorMessage(`Atlarix couldn't start: ${(e as Error).message}`, "Show log").then((s) => s && log.show());
        return null;
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const binaryPath = () => findAtlarix(context.extensionPath, vscode.workspace.getConfiguration("atlarix").get<string>("cliPath")).binary;
  // The status bar: Rix, the model of the chat in use, and a dot while it works.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "atlarix.pickModel";
  const showStatus = () => {
    const chat = lastActive ?? sidebar;
    if (!vscode.workspace.workspaceFolders?.length || !chat?.model) return statusItem.hide();
    statusItem.text = `${chat.busy ? "$(loading~spin)" : "◆"} ${chat.model}`;
    statusItem.tooltip = chat.busy ? "Atlarix is working. Click to pick a model." : "Atlarix model. Click to pick another.";
    statusItem.show();
  };

  /** The file open in the editor, offered to each chat as context (atlarix.attachOpenFile). */
  const activeFileItem = (): ContextItem | null => {
    if (!vscode.workspace.getConfiguration("atlarix").get<boolean>("attachOpenFile", true)) return null;
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(doc.uri)) return null;
    const root = workspace();
    return { path: doc.uri.fsPath, label: root ? path.relative(root, doc.uri.fsPath) : path.basename(doc.uri.fsPath) };
  };
  const shareActiveFile = () => {
    const item = activeFileItem();
    for (const c of chats) c.setActiveFile(item);
  };

  /** The active terminal's selection. `Terminal.selection` is newer than the oldest editors this supports; without it, copy the selection and put the clipboard back. */
  const terminalSelection = async (): Promise<ContextItem | null> => {
    const term = vscode.window.activeTerminal;
    if (!term) return null;
    let text = (term as { selection?: string }).selection;
    if (text === undefined) {
      const saved = await vscode.env.clipboard.readText();
      await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
      text = await vscode.env.clipboard.readText();
      await vscode.env.clipboard.writeText(saved);
      if (text === saved) text = "";
    }
    return text?.trim() ? { path: "", label: `Terminal (${term.name})`, text: text.trim() } : null;
  };

  const SETTINGS_KEY = "atlarix.hostSettings";
  const settings = (): HostSettings => {
    const kept = context.globalState.get<Partial<HostSettings>>(SETTINGS_KEY) ?? {};
    return {
      attachOpenFile: vscode.workspace.getConfiguration("atlarix").get<boolean>("attachOpenFile", true),
      ctrlEnterSends: kept.ctrlEnterSends ?? false,
      notifyWhenNeeded: kept.notifyWhenNeeded ?? true,
    };
  };

  const host: ChatHost = {
    binaryPath,
    changed: () => showStatus(),
    terminalSelection,
    settings,
    setSetting: async (key, value) => {
      if (key === "attachOpenFile") {
        await vscode.workspace.getConfiguration("atlarix").update("attachOpenFile", value, vscode.ConfigurationTarget.Global);
        shareActiveFile();
        return;
      }
      await context.globalState.update(SETTINGS_KEY, { ...(context.globalState.get<Partial<HostSettings>>(SETTINGS_KEY) ?? {}), [key]: value });
    },
    openElsewhere: (sessionId, folder) => handleOpen(sessionId, folder),
    problems: () => {
      const root = workspace();
      const active = vscode.window.activeTextEditor?.document.uri;
      const all = vscode.languages.getDiagnostics();
      const text = problemsText(
        all.map(([uri, list]) => ({
          file: root ? path.relative(root, uri.fsPath) : uri.fsPath,
          active: active?.toString() === uri.toString(),
          items: list.map((d) => ({ line: d.range.start.line + 1, column: d.range.start.character + 1, severity: d.severity, message: d.message, source: d.source })),
        })),
        50,
      );
      return text ? { path: "", label: text.label, text: text.body } : null;
    },
    connection: connect,
    startError: () => startError,
    workspace,
    diffs,
    openInTab: (sessionId) => openTab(sessionId),
    showLog: () => log.show(),
    signIn: async () => {
      // One sign-in at a time: another click shows its page again. Each click
      // used to start its own, and an earlier page then led nowhere.
      if (signingIn) {
        if (signInUrl) void vscode.env.openExternal(vscode.Uri.parse(signInUrl));
        return signingIn;
      }
      const c = await connect();
      if (!c) return;
      signingIn = Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Signing in to Atlarix — finish in your browser…", cancellable: false },
          () => c.authenticate(),
        ),
      ).then(() => undefined);
      // Only when the browser didn't come up (the agent on another machine, a
      // blocked opener): after a few seconds, offer to open the page from here.
      const fallback = setTimeout(() => {
        if (!signingIn || !signInUrl) return;
        void vscode.window.showInformationMessage("Didn't see Atlarix's sign-in page in your browser?", "Open the sign-in page").then((go) => {
          if (go && signInUrl) void vscode.env.openExternal(vscode.Uri.parse(signInUrl));
        });
      }, 20_000);
      try {
        await signingIn;
      } finally {
        clearTimeout(fallback);
        signingIn = null;
        signInUrl = null;
      }
    },
  };

  const track = (chat: Chat, panel: { onDidChangeViewState: vscode.Event<unknown> } | null) => {
    chats.add(chat);
    lastActive = chat;
    if (panel)
      panel.onDidChangeViewState(() => {
        lastActive = chat;
        showStatus();
      });
    // Once its webview is up (setActiveFile before then would be lost).
    setTimeout(() => chat.setActiveFile(activeFileItem()), 800);
  };

  const openTab = (sessionId: string | null) => {
    const panel = vscode.window.createWebviewPanel("atlarix.chatTab", "Atlarix", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist"), vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "rix-glyph.svg");
    panel.webview.html = chatHtml(panel.webview, context.extensionUri);
    const chat = new Chat(panel.webview, host, sessionId, "tab", () => panel.reveal(), (title) => {
      panel.title = title ?? "Atlarix";
    });
    track(chat, panel);
    panel.onDidDispose(() => {
      chat.dispose();
      chats.delete(chat);
      if (lastActive === chat) lastActive = sidebar;
      showStatus();
    });
  };

  const target = async (): Promise<Chat | null> => {
    if (lastActive) return lastActive;
    await vscode.commands.executeCommand("atlarix.chat.focus");
    return sidebar;
  };

  /**
   * `vscode://atlarix.atlarix/open?session=…&folder=…` — the CLI's /editor and
   * the app's "Open in your editor" (src/lib/peers/open-in-editor.ts). A
   * session from another folder opens that folder in a new window, which picks
   * the session up from here when it starts.
   */
  const PENDING = "atlarix.pendingSession";
  const openSessionHere = (sessionId: string) => {
    if (sidebar && !sidebar.sessionId) void vscode.commands.executeCommand("atlarix.chat.focus").then(() => sidebar?.open(sessionId));
    else openTab(sessionId);
  };
  const samePath = (a: string, b: string) =>
    process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const handleOpen = async (sessionId: string, folder: string) => {
    const here = vscode.workspace.workspaceFolders?.some((f) => samePath(f.uri.fsPath, folder));
    if (!folder || here) return openSessionHere(sessionId);
    await context.globalState.update(PENDING, { sessionId, folder, at: Date.now() });
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folder), { forceNewWindow: true });
  };
  const pending = context.globalState.get<{ sessionId: string; folder: string; at: number }>(PENDING);
  if (pending && Date.now() - pending.at < 120_000 && vscode.workspace.workspaceFolders?.some((f) => samePath(f.uri.fsPath, pending.folder))) {
    void context.globalState.update(PENDING, undefined);
    setTimeout(() => openSessionHere(pending.sessionId), 500);
  }

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const q = new URLSearchParams(uri.query);
        const sessionId = q.get("session") ?? "";
        if (uri.path === "/open" && /^[\w-]+$/.test(sessionId)) void handleOpen(sessionId, q.get("folder") ?? "");
      },
    }),
    log,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
    vscode.window.registerWebviewViewProvider(
      "atlarix.chat",
      {
        resolveWebviewView(view) {
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist"), vscode.Uri.joinPath(context.extensionUri, "media")],
          };
          view.webview.html = chatHtml(view.webview, context.extensionUri);
          sidebar = new Chat(
            view.webview,
            host,
            null,
            "sidebar",
            () => void vscode.commands.executeCommand("atlarix.chat.focus"),
            (title) => {
              // The title, not the description: the Atlarix container has one
              // view, so VS Code hides the view's own header (and its
              // description) and shows "Atlarix: <view title>" (QA E2).
              view.title = title ?? "Chat";
            },
          );
          track(sidebar, null);
          view.onDidChangeVisibility(() => {
            if (view.visible) lastActive = sidebar;
            showStatus();
          });
          view.onDidDispose(() => {
            sidebar?.dispose();
            if (sidebar) chats.delete(sidebar);
            sidebar = null;
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("atlarix.focus", () => vscode.commands.executeCommand("atlarix.chat.focus")),
    vscode.commands.registerCommand("atlarix.newChat", async () => {
      await vscode.commands.executeCommand("atlarix.chat.focus");
      await sidebar?.open(null);
    }),
    vscode.commands.registerCommand("atlarix.openInTab", async () => {
      // Moves the chat: the view it came from starts a new one (no two views on one session).
      const from = lastActive;
      if (from?.busy) return void vscode.window.showInformationMessage("Wait for this turn to finish (or stop it), then move the chat.");
      openTab(from?.sessionId ?? null);
      if (from?.sessionId) await from.open(null);
    }),
    vscode.commands.registerCommand("atlarix.manageKeys", async () => (await target())?.show("keys")),
    vscode.commands.registerCommand("atlarix.settings", async () => (await target())?.show("settings")),
    vscode.commands.registerCommand("atlarix.account", async () => (await target())?.show("account")),
    vscode.commands.registerCommand("atlarix.mcp", async () => (await target())?.show("mcp")),
    vscode.commands.registerCommand("atlarix.automations", async () => (await target())?.show("automations")),
    vscode.commands.registerCommand("atlarix.pickModel", async () => {
      const chat = await target();
      if (chat === sidebar) await vscode.commands.executeCommand("atlarix.chat.focus");
      chat?.show("model-picker");
    }),
    vscode.commands.registerCommand("atlarix.insertReference", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.uri.scheme !== "file") return;
      const root = workspace();
      const file = ed.document.uri.fsPath;
      const rel = root ? path.relative(root, file) : path.basename(file);
      const sel = ed.selection;
      const item: ContextItem = sel.isEmpty
        ? { path: file, label: rel }
        : {
            path: file,
            label: `${rel}#L${sel.start.line + 1}${sel.end.line !== sel.start.line ? `-${sel.end.line + 1}` : ""}`,
            startLine: sel.start.line + 1,
            endLine: sel.end.line + 1,
            text: ed.document.getText(sel),
          };
      (await target())?.addContext(item);
    }),
    vscode.commands.registerCommand("atlarix.addProblems", async () => {
      const item = host.problems();
      if (!item) return void vscode.window.showInformationMessage("No errors or warnings in the Problems panel.");
      (await target())?.addContext(item);
    }),
    vscode.commands.registerCommand("atlarix.addTerminalSelection", async () => {
      const item = await terminalSelection();
      if (!item) return void vscode.window.showInformationMessage("Select some terminal output first.");
      (await target())?.addContext(item);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => shareActiveFile()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("atlarix.attachOpenFile") && shareActiveFile()),
    statusItem,
    vscode.commands.registerCommand("atlarix.history", async () => {
      await vscode.commands.executeCommand("atlarix.chat.focus");
      sidebar?.show("history");
    }),
    vscode.commands.registerCommand("atlarix.signIn", () => host.signIn()),
    vscode.commands.registerCommand("atlarix.showLog", () => log.show()),
    vscode.commands.registerCommand("atlarix.addSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) return;
      const root = workspace();
      const file = ed.document.uri.fsPath;
      const item: ContextItem = {
        path: file,
        label: `${root ? path.relative(root, file) : path.basename(file)}:${ed.selection.start.line + 1}-${ed.selection.end.line + 1}`,
        startLine: ed.selection.start.line + 1,
        endLine: ed.selection.end.line + 1,
        text: ed.document.getText(ed.selection),
      };
      (await target())?.addContext(item);
    }),
    vscode.commands.registerCommand("atlarix.addFile", async (uri?: vscode.Uri) => {
      const file = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!file) return;
      const root = workspace();
      (await target())?.addContext({ path: file.fsPath, label: root ? path.relative(root, file.fsPath) : path.basename(file.fsPath) });
    }),
    { dispose: () => connection?.dispose() },
  );
}

/** VS Code waits on this: the agent gets to clean up before the window goes (QA E11). */
export function deactivate(): Promise<void> | undefined {
  const c = connection;
  connection = null;
  return c?.dispose();
}
