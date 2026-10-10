/**
 * Atlarix for VS Code and the editors built on it (Cursor, Kiro, Windsurf…).
 *
 * The agent is the Atlarix CLI running as `atlarix acp`; this extension is its
 * window: a chat in the side bar (or an editor tab), edits shown in the
 * editor's own diff, and the editor's selection and files as context.
 */
import path from "node:path";
import { noteTurn, ratingUrl, type RatingState } from "./rating";
import * as vscode from "vscode";
import { findAtlarix } from "./binary";
import { Chat, type ChatHost } from "./chat";
import { AtlarixConnection } from "./connection";
import { DIFF_SCHEME, DiffDocuments } from "./diff";
import { chatHtml } from "./html";
import type { ContextItem } from "./protocol";

let connection: AtlarixConnection | null = null;
let starting: Promise<AtlarixConnection | null> | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Atlarix");
  const diffs = new DiffDocuments();
  const chats = new Set<Chat>();
  let sidebar: Chat | null = null;
  let sidebarView: vscode.WebviewView | null = null;
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
      const binary = findAtlarix(context.extensionPath, vscode.workspace.getConfiguration("atlarix").get<string>("cliPath"));
      if (!binary) {
        void vscode.window
          .showErrorMessage("Atlarix couldn't find its agent program. Reinstall the extension, or install the CLI (npm i -g atlarix).", "Get Atlarix")
          .then((go) => go && vscode.env.openExternal(vscode.Uri.parse("https://atlarix.dev/download")));
        return null;
      }
      log.appendLine(`Starting ${binary} acp`);
      const c = new AtlarixConnection({
        binary,
        cwd: workspace() ?? path.dirname(binary),
        version,
        log: (l) => log.appendLine(l),
        openUrl: (u) => {
          signInUrl = u;
          void vscode.env.openExternal(vscode.Uri.parse(u));
        },
        onExit: (code) => {
          log.appendLine(`Atlarix exited (${code})`);
          if (connection === c) connection = null;
        },
      });
      try {
        await c.start();
        connection = c;
        return c;
      } catch (e) {
        log.appendLine(`Couldn't start Atlarix: ${(e as Error).message}`);
        c.dispose();
        void vscode.window.showErrorMessage(`Atlarix couldn't start: ${(e as Error).message}`, "Show log").then((s) => s && log.show());
        return null;
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const binaryPath = () => findAtlarix(context.extensionPath, vscode.workspace.getConfiguration("atlarix").get<string>("cliPath"));
  const RATING_KEY = "atlarix.rating";
  const turnFinished = () => {
    const { state, ask } = noteTurn(context.globalState.get<RatingState>(RATING_KEY) ?? { turns: 0, asked: false });
    void context.globalState.update(RATING_KEY, state);
    if (!ask) return;
    void vscode.window
      .showInformationMessage("Enjoying Atlarix? A rating helps other developers find it.", "Rate Atlarix", "Not now")
      .then((pick) => pick === "Rate Atlarix" && vscode.env.openExternal(vscode.Uri.parse(ratingUrl(vscode.env.appName))));
  };
  const host: ChatHost = {
    binaryPath,
    connection: connect,
    workspace,
    diffs,
    openInTab: (sessionId) => openTab(sessionId),
    showLog: () => log.show(),
    turnFinished,
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
      try {
        await signingIn;
      } finally {
        signingIn = null;
        signInUrl = null;
      }
    },
  };

  const track = (chat: Chat, panel: { onDidChangeViewState: vscode.Event<unknown> } | null) => {
    chats.add(chat);
    lastActive = chat;
    if (panel) panel.onDidChangeViewState(() => (lastActive = chat));
  };

  const openTab = (sessionId: string | null) => {
    const panel = vscode.window.createWebviewPanel("atlarix.chatTab", "Atlarix", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist"), vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "rix-glyph.svg");
    panel.webview.html = chatHtml(panel.webview, context.extensionUri);
    const chat = new Chat(panel.webview, host, sessionId, "tab");
    track(chat, panel);
    panel.onDidDispose(() => {
      chat.dispose();
      chats.delete(chat);
      if (lastActive === chat) lastActive = sidebar;
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
          sidebarView = view;
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist"), vscode.Uri.joinPath(context.extensionUri, "media")],
          };
          view.webview.html = chatHtml(view.webview, context.extensionUri);
          sidebar = new Chat(view.webview, host);
          track(sidebar, null);
          view.onDidChangeVisibility(() => view.visible && (lastActive = sidebar));
          view.onDidDispose(() => {
            sidebar?.dispose();
            if (sidebar) chats.delete(sidebar);
            sidebar = null;
            sidebarView = null;
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
    vscode.commands.registerCommand("atlarix.openInTab", () => openTab(lastActive?.sessionId ?? null)),
    vscode.commands.registerCommand("atlarix.history", async () => {
      await vscode.commands.executeCommand("atlarix.chat.focus");
      void sidebarView?.webview.postMessage({ type: "open-history" });
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

export function deactivate(): void {
  connection?.dispose();
  connection = null;
}
