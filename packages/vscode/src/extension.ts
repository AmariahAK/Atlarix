/**
 * Atlarix for VS Code and the editors built on it (Cursor, Kiro, Windsurf…).
 *
 * The agent is the Atlarix CLI running as `atlarix acp`; this extension is its
 * window: a chat in the side bar (or an editor tab), edits shown in the
 * editor's own diff, and the editor's selection and files as context.
 */
import path from "node:path";
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
        openUrl: (u) => void vscode.env.openExternal(vscode.Uri.parse(u)),
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

  const host: ChatHost = {
    connection: connect,
    workspace,
    diffs,
    openInTab: (sessionId) => openTab(sessionId),
    showLog: () => log.show(),
    signIn: async () => {
      const c = await connect();
      if (!c) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Signing in to Atlarix — finish in your browser…", cancellable: false },
        () => c.authenticate(),
      );
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
    const chat = new Chat(panel.webview, host, sessionId);
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

  context.subscriptions.push(
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
