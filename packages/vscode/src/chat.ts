/**
 * One chat: a webview (the side bar or an editor tab) and the Atlarix session
 * it is showing. Turns what the user does into ACP requests and what the agent
 * sends into messages the webview draws.
 *
 * The screens that only read or change Atlarix's own data (keys, past chats,
 * MCP, permissions, account) call allow-listed `_atlarix/*` methods through
 * `rpc`; this file keeps what needs the editor itself: diffs, files, git, the
 * clipboard, input boxes, links, and the turn's lifecycle.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import type {
  ContentBlock,
  SessionConfigOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { recapDecision, type RecapClock } from "@/lib/recap/rules";
import { isAuthRequired, type AtlarixConnection, type SessionListener } from "./connection";
import type { DiffDocuments } from "./diff";
import { RPC_METHODS, type ContextItem, type HostMessage, type HostSettings, type ViewMessage } from "./protocol";
import { rankFiles } from "./files";
import { keptFilesLine } from "../../../src/lib/chat/kept-files-line";

export interface ChatHost {
  /** The `atlarix` program this extension runs (for "Continue in the terminal"). */
  binaryPath(): string | null;
  connection(): Promise<AtlarixConnection | null>;
  workspace(): string | null;
  diffs: DiffDocuments;
  openInTab(sessionId: string | null): void;
  /** A chat from another folder: open that folder in a new window, resumed there. */
  openElsewhere(sessionId: string, folder: string): Promise<void>;
  showLog(): void;
  signIn(): Promise<void>;
  /** A turn finished normally (counts toward the one-time rating request). */
  turnFinished(): void;
  /** This chat's model or busy state changed (the status bar). */
  changed?(chat: Chat): void;
  /** The Problems panel's errors and warnings, as context. */
  problems(): ContextItem | null;
  /** The active terminal's selection, as context. */
  terminalSelection(): Promise<ContextItem | null>;
  settings(): HostSettings;
  setSetting(key: keyof HostSettings, value: boolean): Promise<void>;
}

interface Pending {
  resolve: (r: RequestPermissionResponse) => void;
  diffDocs: vscode.Uri[];
  diff: { path: string; oldText: string | null; newText: string } | null;
}

/** Three minutes; shorter only for the end-to-end test (ATLARIX_RECAP_AWAY_MS). */
const AWAY_MS = Number(process.env.ATLARIX_RECAP_AWAY_MS) > 0 ? Number(process.env.ATLARIX_RECAP_AWAY_MS) : 3 * 60_000;
const ALLOWED = new Set<string>(RPC_METHODS);

/** `git` in the workspace; its output, or null when git or the repo isn't there. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) =>
    execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (err, out) => resolve(err ? null : String(out))),
  );
}

/** The agent's own reason, without the protocol's labels in front. */
function errorText(e: unknown): string {
  return ((e as Error)?.message ?? String(e)).replace(/^(Internal error|Invalid params):\s*/i, "");
}

export class Chat {
  sessionId: string | null = null;
  /** The model shown in the picker, for the status bar. */
  model: string | null = null;
  busy = false;
  private listener: SessionListener | null = null;
  private files: { at: number; list: Array<{ path: string; label: string }> } | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private peerWaiting = false;
  /** Background work finished during a turn: wake the agent once this one ends. */
  private wakeWaiting = false;
  private readonly recapClock: RecapClock = { completedTurns: 0, lastTurnEndedAt: null, recappedAfterTurn: -1 };
  private awaySince: number | null = null;
  private recapTimer: ReturnType<typeof setTimeout> | null = null;
  private recapReady: string | null = null;
  private recapOn = true;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly host: ChatHost,
    private readonly startWith: string | null = null,
    private readonly where: "sidebar" | "tab" = "sidebar",
    /** Bring this chat's panel to the front (a "needs you" notification's Show). */
    private readonly reveal: () => void = () => {},
  ) {
    webview.onDidReceiveMessage((m: ViewMessage) => void this.onMessage(m));
  }

  private post(m: HostMessage): void {
    void this.webview.postMessage(m);
  }

  private toast(text: string, tone: "info" | "error" = "info"): void {
    this.post({ type: "toast", text, tone });
  }

  private async onMessage(m: ViewMessage): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          this.post({
            type: "host-info",
            appName: vscode.env.appName,
            version: vscode.version,
            where: this.where,
            workspace: this.host.workspace(),
            settings: this.host.settings(),
          });
          // The page loads again on a reload (or after sleep): reopen the chat
          // this view is ON, not the one it was first opened with. A tab opened
          // from Past chats then New chat used to reload the old chat, and the
          // next message went there (QA #52).
          await this.opening?.catch(() => {});
          await this.open(this.sessionId ?? this.startWith);
          return;
        case "send":
          return this.send(m.text, m.context, m.answers);
        case "cancel":
          if (this.sessionId) (await this.host.connection())?.cancel(this.sessionId);
          return;
        case "set-option": {
          const c = await this.host.connection();
          if (!c || !this.sessionId) return;
          const configOptions = await c.setOption(this.sessionId, m.configId, m.value);
          this.noteOptions(configOptions);
          this.post({ type: "update", update: { sessionUpdate: "config_option_update", configOptions } });
          return;
        }
        case "permission":
          return this.answerPermission(m.requestId, m.optionId);
        case "open-diff": {
          const p = this.pending.get(m.requestId);
          if (p?.diff) p.diffDocs = await this.host.diffs.show(m.requestId, p.diff.path, p.diff.oldText, p.diff.newText);
          return;
        }
        case "build":
          return this.send("/build", []);
        case "new-chat":
          return this.open(null);
        case "load-session":
          if (m.folder && !this.isHere(m.folder)) return this.host.openElsewhere(m.sessionId, m.folder);
          return this.open(m.sessionId);
        case "pick-file":
          return this.pickFile();
        case "pick-image":
          return this.pickImage();
        case "pick-folder":
          return this.pickFolder();
        case "add-url":
          return this.addUrl();
        case "add-git":
          return this.addGit(m.what);
        case "add-problems": {
          const item = this.host.problems();
          if (item) this.addContext(item);
          else this.toast("No errors or warnings in the Problems panel.");
          return;
        }
        case "add-terminal": {
          const item = await this.host.terminalSelection();
          if (item) this.addContext(item);
          else this.toast("Select some output in a terminal first.");
          return;
        }
        case "open-file": {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.path));
          const line = Math.max(0, (m.line ?? 1) - 1);
          await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
          return;
        }
        case "open-url":
          if (/^https?:\/\//i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
          return;
        case "sign-in":
          await this.host.signIn();
          return this.open(this.sessionId);
        case "sign-out":
          return this.signOut();
        case "open-in-tab":
          return this.moveToTab();
        case "visible":
          return this.onVisibility(m.visible && m.focused);
        case "show-log":
          this.host.showLog();
          return;
        case "continue-in-app":
          return this.continueInApp();
        case "continue-in-terminal":
          return this.continueInTerminal();
        case "checkout":
          return this.checkout(m.kind);
        case "manage-subscription":
          await vscode.env.openExternal(vscode.Uri.parse("https://www.atlarix.dev/account"));
          return;
        case "find-files":
          return this.findFiles(m.query);
        case "copy":
          await vscode.env.clipboard.writeText(m.text);
          this.toast("Copied.");
          return;
        case "compare":
          return this.compare(m.turnId, m.path);
        case "undo-resend":
          return this.resend(m.messageId, m.text, m.restore);
        case "rpc":
          return this.rpc(m.id, m.method, m.params);
        case "host-setting":
          await this.host.setSetting(m.key, m.value);
          this.post({ type: "host-settings", settings: this.host.settings() });
          return;
        case "needs-you":
          return this.notifyNeeded(m.what);
      }
    } catch (e) {
      this.post({ type: "turn-end", stopReason: null, error: errorText(e) });
    }
  }

  private isHere(folder: string): boolean {
    const here = this.host.workspace();
    if (!here) return false;
    const norm = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? path.resolve(p).toLowerCase() : path.resolve(p));
    return norm(here) === norm(folder);
  }

  /** An allow-listed `_atlarix/*` call from the webview, answered with its result or the agent's reason. */
  private async rpc(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    if (!ALLOWED.has(method)) return this.post({ type: "rpc-result", id, error: `Not available: ${method}` });
    const c = await this.host.connection();
    if (!c) return this.post({ type: "rpc-result", id, error: "Atlarix isn't running." });
    try {
      const result = await c.request(method, params);
      if (method === "_atlarix/recap_setting") this.recapOn = params.on === true;
      this.post({ type: "rpc-result", id, result });
    } catch (e) {
      this.post({ type: "rpc-result", id, error: errorText(e), data: (e as { data?: unknown }).data });
    }
  }

  /**
   * A New chat or a load still on its way. Until it lands, `sessionId` is the
   * PREVIOUS chat's, so a message sent right after New chat went into the old
   * chat while the panel showed the new one (QA #52). Sends wait for it.
   */
  private opening: Promise<void> | null = null;

  /** Start a chat, or load a past one into this view. */
  async open(sessionId: string | null): Promise<void> {
    const run = this.openNow(sessionId);
    this.opening = run;
    try {
      await run;
    } finally {
      if (this.opening === run) this.opening = null;
    }
  }

  private async openNow(sessionId: string | null): Promise<void> {
    const cwd = this.host.workspace();
    if (!cwd) return this.post({ type: "status", status: "no-folder" });
    this.post({ type: "status", status: "starting" });
    const c = await this.host.connection();
    if (!c) return;
    // Only this chat's own listener: another chat may have taken the session over.
    if (this.sessionId) c.forget(this.sessionId, this.listener ?? undefined);
    for (const id of [...this.pending.keys()]) this.answerPermission(id, null);
    try {
      const listener: SessionListener = {
        update: (n: SessionNotification) => this.onUpdate(n),
        permission: (req: RequestPermissionRequest) => this.onPermission(req),
        peerWaiting: () => this.onPeerWaiting(),
        tasksChanged: (count) => this.post({ type: "tasks-changed", count }),
        automationRun: (run) => this.post({ type: "automation-run", ...run }),
        pendingChanged: (items) => this.post({ type: "pending", items }),
        workingChanged: (title) => this.post({ type: "working", title }),
        unsent: (text) => this.post({ type: "unsent", text }),
        backgroundReady: () => this.onBackgroundReady(),
      };
      this.listener = listener;
      if (sessionId) {
        // Listen first: the replay arrives as updates while load is answered.
        this.sessionId = sessionId;
        c.listen(sessionId, listener);
        this.post({ type: "session", sessionId, title: null, modes: null, configOptions: [], replay: true });
        const r = await c.loadSession(cwd, sessionId);
        this.noteOptions(r?.configOptions ?? []);
        this.post({ type: "session", sessionId, title: null, modes: r?.modes ?? null, configOptions: r?.configOptions ?? [], replay: false });
      } else {
        const r = await c.newSession(cwd);
        this.sessionId = r.sessionId;
        c.listen(r.sessionId, listener);
        this.noteOptions(r.configOptions ?? []);
        this.post({ type: "session", sessionId: r.sessionId, title: null, modes: r.modes ?? null, configOptions: r.configOptions ?? [], replay: false });
      }
      Object.assign(this.recapClock, { completedTurns: 0, lastTurnEndedAt: null, recappedAfterTurn: -1 });
      this.post({ type: "status", status: "ready" });
      const st = await c.status().catch(() => ({}) as { chrome?: string; recap?: boolean });
      if (st.chrome) this.post({ type: "chrome", status: st.chrome });
      if (typeof st.recap === "boolean") {
        this.recapOn = st.recap;
        this.post({ type: "recap-setting", on: st.recap });
      }
    } catch (e) {
      if (isAuthRequired(e)) return this.post({ type: "status", status: "signed-out" });
      this.post({ type: "status", status: "error", detail: errorText(e) });
    }
  }

  private onUpdate(n: SessionNotification): void {
    if (n.update.sessionUpdate === "config_option_update") this.noteOptions(n.update.configOptions);
    this.post({ type: "update", update: n.update });
  }

  /** The model the picker shows, by name, for the status bar. */
  private noteOptions(options: SessionConfigOption[]): void {
    const o = options.find((x) => x.id === "model");
    if (!o || o.type !== "select") return;
    const flat = (o.options as Array<{ value: string; name: string } | { options: Array<{ value: string; name: string }> }>).flatMap((x) =>
      "options" in x ? x.options : [x],
    );
    this.model = flat.find((x) => x.value === o.currentValue)?.name ?? null;
    this.host.changed?.(this);
  }

  private blocks(text: string, context: ContextItem[]): ContentBlock[] {
    const out: ContentBlock[] = [];
    if (text.trim()) out.push({ type: "text", text });
    for (const item of context) {
      if (!item.path) {
        // Not a file: a pasted image, or text from the editor (Problems, the terminal, git).
        if (item.image) out.push({ type: "image", data: item.image.data, mimeType: item.image.mimeType });
        else if (item.text) out.push({ type: "text", text: `${item.label}:\n${item.text}` });
        continue;
      }
      const uri = pathToFileURL(item.path).href;
      if (item.image) {
        out.push({ type: "image", data: item.image.data, mimeType: item.image.mimeType, uri });
      } else if (item.text != null) {
        const lines = item.startLine ? `Lines ${item.startLine}–${item.endLine ?? item.startLine}:\n` : "";
        out.push({ type: "resource", resource: { uri, text: `${lines}${item.text}`, mimeType: "text/plain" } });
      } else {
        out.push({ type: "resource_link", uri, name: path.basename(item.path) });
      }
    }
    return out;
  }

  private beginTurn(): boolean {
    if (this.busy) return false;
    this.busy = true;
    this.host.changed?.(this);
    this.recapReady = null;
    return true;
  }

  private endTurn(): void {
    this.busy = false;
    this.host.changed?.(this);
    this.recapClock.completedTurns++;
    this.recapClock.lastTurnEndedAt = Date.now();
    if (this.peerWaiting) this.onPeerWaiting();
    else if (this.wakeWaiting) this.onBackgroundReady();
    else if (this.awaySince != null) this.armRecap();
  }

  private async send(text: string, context: ContextItem[], answers?: string[], meta?: Record<string, unknown>): Promise<void> {
    await this.opening?.catch(() => {});
    const c = await this.host.connection();
    if (!c || !this.sessionId || !this.beginTurn()) return;
    const sessionId = this.sessionId;
    try {
      const r = await c.prompt(sessionId, this.blocks(text, context), answers?.length ? { answers, ...meta } : meta);
      this.post({ type: "turn-end", stopReason: r.stopReason });
      if (r.stopReason === "end_turn") this.host.turnFinished();
    } catch (e) {
      if (isAuthRequired(e)) this.post({ type: "status", status: "signed-out" });
      this.post({ type: "turn-end", stopReason: null, error: errorText(e) });
    } finally {
      this.endTurn();
    }
  }

  /** Go back to an earlier message, edited: the agent sends the conversation again from the top. */
  private async resend(messageId: number, text: string, restore: boolean): Promise<void> {
    await this.opening?.catch(() => {});
    const c = await this.host.connection();
    if (!c || !this.sessionId || !this.beginTurn()) return;
    try {
      const r = await c.request<{ stopReason?: string; _meta?: { atlarix?: { kept?: string[] } } }>("_atlarix/undo", { sessionId: this.sessionId, action: "resend", messageId, text, restore });
      this.post({ type: "turn-end", stopReason: r.stopReason ?? "end_turn" });
      const kept = keptFilesLine(r._meta?.atlarix?.kept ?? []);
      if (kept) this.toast(kept);
    } catch (e) {
      this.post({ type: "turn-end", stopReason: null, error: errorText(e) });
    } finally {
      this.endTurn();
    }
  }

  /** Another session messaged this one while it was idle: read it now, as the app does. */
  /**
   * A background command or sub-agent finished while the chat was idle: open a
   * turn so the agent deals with it, as the desktop app does. The agent refuses
   * one after you stopped the turn.
   */
  private onBackgroundReady(): void {
    if (this.busy) {
      this.wakeWaiting = true;
      return;
    }
    this.wakeWaiting = false;
    this.post({ type: "turn-start" });
    void this.send("", [], undefined, { wakeTurn: true });
  }

  private onPeerWaiting(): void {
    if (this.busy) {
      this.peerWaiting = true;
      return;
    }
    this.peerWaiting = false;
    this.post({ type: "turn-start" });
    void this.send("", [], undefined, { peerTurn: true });
  }

  private onPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = `p${++this.seq}`;
    const diffBlock = req.toolCall.content?.find((x) => x.type === "diff") as
      | { type: "diff"; path: string; oldText?: string | null; newText: string }
      | undefined;
    const diff = diffBlock ? { path: diffBlock.path, oldText: diffBlock.oldText ?? null, newText: diffBlock.newText } : null;
    this.notifyNeeded(req.toolCall.title ?? "An approval is waiting");
    return new Promise<RequestPermissionResponse>((resolve) => {
      const pending: Pending = { resolve, diffDocs: [], diff };
      this.pending.set(requestId, pending);
      this.post({ type: "permission", requestId, toolCall: req.toolCall, options: req.options, hasDiff: !!diff });
      if (diff) {
        void this.host.diffs.show(requestId, diff.path, diff.oldText, diff.newText).then((docs) => {
          pending.diffDocs = docs;
        });
      }
    });
  }

  /** A VS Code notification while you're away from the panel, when Settings › Auto-approve says so. */
  private notifyNeeded(what: string): void {
    if (this.awaySince == null || !this.host.settings().notifyWhenNeeded) return;
    void vscode.window.showInformationMessage(`Atlarix needs you: ${what}`, "Show").then((pick) => pick && this.reveal());
  }

  private answerPermission(requestId: string, optionId: string | null): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    void this.host.diffs.close(p.diffDocs);
    p.resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    this.post({ type: "permission-done", requestId });
  }

  // --- Context from the editor ------------------------------------------------

  private async pickFile(): Promise<void> {
    const root = this.host.workspace();
    const files = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out,build}/**", 5000);
    const picked = await vscode.window.showQuickPick(
      files.map((f) => ({ label: root ? path.relative(root, f.fsPath) : f.fsPath, uri: f })),
      { placeHolder: "Add a file to the chat", matchOnDescription: true },
    );
    if (picked) this.addContext({ path: picked.uri.fsPath, label: picked.label });
  }

  private async pickFolder(): Promise<void> {
    const root = this.host.workspace();
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: root ? vscode.Uri.file(root) : undefined,
      openLabel: "Add folder",
    });
    const dir = picked?.[0]?.fsPath;
    if (dir) this.addContext({ path: dir, label: `${root ? path.relative(root, dir) || "." : path.basename(dir)}/`, folder: true });
  }

  private async pickImage(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    for (const uri of picked ?? []) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
      const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      this.addContext({ path: uri.fsPath, label: path.basename(uri.fsPath), image: { data: Buffer.from(bytes).toString("base64"), mimeType } });
    }
  }

  private async addUrl(): Promise<void> {
    const url = await vscode.window.showInputBox({
      title: "Add a page to the chat",
      placeHolder: "https://…",
      validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? null : "A link starting with https://"),
    });
    if (url) this.addContext({ path: "", label: "Read this page", text: url.trim() });
  }

  /** Git changes (the working tree's diff) or one commit, as text the agent reads. */
  private async addGit(what: "changes" | "commit"): Promise<void> {
    const root = this.host.workspace();
    if (!root) return;
    if (what === "changes") {
      const diff = (await git(root, ["diff", "HEAD"])) ?? (await git(root, ["diff"]));
      if (diff == null) return this.toast("This folder isn't a git repository.", "error");
      if (!diff.trim()) return this.toast("No uncommitted changes.");
      return this.addContext({ path: "", label: "Uncommitted changes (git diff)", text: diff.slice(0, 60_000) });
    }
    const log = await git(root, ["log", "--oneline", "-30"]);
    if (log == null) return this.toast("This folder isn't a git repository.", "error");
    const picked = await vscode.window.showQuickPick(
      log.trim().split("\n").filter(Boolean).map((l) => ({ label: l.slice(l.indexOf(" ") + 1), description: l.split(" ")[0], sha: l.split(" ")[0]! })),
      { placeHolder: "Add a commit to the chat" },
    );
    if (!picked) return;
    const show = await git(root, ["show", "--stat", "--patch", picked.sha]);
    if (show) this.addContext({ path: "", label: `Commit ${picked.sha}`, text: show.slice(0, 60_000) });
  }

  private async findFiles(query: string): Promise<void> {
    const root = this.host.workspace();
    if (!this.files || Date.now() - this.files.at > 30_000) {
      const found = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out,build}/**", 5000);
      this.files = { at: Date.now(), list: found.map((f) => ({ path: f.fsPath, label: root ? path.relative(root, f.fsPath) : f.fsPath })) };
    }
    this.post({ type: "files", query, files: rankFiles(this.files.list, query, 20) });
  }

  addContext(item: ContextItem): void {
    this.post({ type: "add-context", item });
  }

  /** Compare at a checkpoint: the file as it was before that turn, against the file now, in VS Code's diff. */
  private async compare(turnId: string, rel: string): Promise<void> {
    const c = await this.host.connection();
    const root = this.host.workspace();
    if (!c || !this.sessionId || !root) return;
    const { file } = await c.request<{ file: { existed: boolean; content: string } | null }>("_atlarix/checkpoint", {
      sessionId: this.sessionId,
      action: "before",
      turnId,
      path: rel,
    });
    if (!file) return this.toast("That checkpoint no longer has this file.", "error");
    const abs = path.resolve(root, rel);
    const now = await vscode.workspace.fs.readFile(vscode.Uri.file(abs)).then(
      (b) => Buffer.from(b).toString("utf8"),
      () => null,
    );
    await this.host.diffs.show(`compare:${turnId}:${rel}`, abs, file.existed ? file.content : null, now ?? "");
  }

  // --- Handoffs, account ---------------------------------------------------------

  private async continueInApp(): Promise<void> {
    const c = await this.host.connection();
    if (!c || !this.sessionId) return;
    try {
      await c.handoff(this.sessionId);
      this.toast("Continued in the Atlarix app. It's the same chat: you can keep going here too.");
    } catch (e) {
      this.toast(errorText(e), "error");
    }
  }

  private continueInTerminal(): void {
    const bin = this.host.binaryPath();
    if (!bin || !this.sessionId) return;
    const t = vscode.window.createTerminal({ name: "Atlarix", cwd: this.host.workspace() ?? undefined, iconPath: new vscode.ThemeIcon("comment-discussion") });
    t.show();
    const quoted = process.platform === "win32" ? `& "${bin}"` : `"${bin}"`;
    t.sendText(`${quoted} --resume ${this.sessionId}`);
  }

  private async signOut(): Promise<void> {
    const ok = await vscode.window.showWarningMessage("Sign out of Atlarix? The app and CLI on this computer share this sign-in.", { modal: true }, "Sign out");
    if (ok !== "Sign out") return;
    await (await this.host.connection())?.signOut();
    this.post({ type: "status", status: "signed-out" });
  }

  private async checkout(kind: "pro" | "credit"): Promise<void> {
    const c = await this.host.connection();
    if (!c) return;
    let amountCents: number | undefined;
    if (kind === "credit") {
      const v = await vscode.window.showInputBox({
        title: "Add Atlarix credit",
        prompt: "Amount in US dollars (at least $10). Credit pays for Atlarix Auto and Core as you go.",
        value: "10",
        validateInput: (s) => (Number(s) >= 10 ? null : "At least $10"),
      });
      if (!v) return;
      amountCents = Math.round(Number(v) * 100);
    }
    try {
      const { url } = await c.checkout(kind, amountCents);
      await vscode.env.openExternal(vscode.Uri.parse(url));
      this.toast("Checkout opened in your browser. Your balance updates here when it's done.");
    } catch (e) {
      this.toast(errorText(e), "error");
    }
  }

  /** "Open in an editor tab" moves this chat there; this view starts a new one, so no two views share a session. */
  private async moveToTab(): Promise<void> {
    if (this.busy) return this.toast("Wait for this turn to finish (or stop it), then move the chat.");
    const id = this.sessionId;
    this.host.openInTab(id);
    if (id) await this.open(null);
  }

  // --- Recap -----------------------------------------------------------------

  private onVisibility(present: boolean): void {
    if (!present) {
      if (this.awaySince == null) this.awaySince = Date.now();
      this.armRecap();
      return;
    }
    this.awaySince = null;
    if (this.recapTimer) clearTimeout(this.recapTimer);
    this.recapTimer = null;
    if (this.recapReady) {
      this.post({ type: "recap", text: this.recapReady });
      this.recapReady = null;
    }
  }

  /** While away, prepare the recap once the rules allow it, so it is ready on return. */
  private armRecap(): void {
    if (this.recapTimer) clearTimeout(this.recapTimer);
    const now = Date.now();
    const d = recapDecision({ ...this.recapClock, enabled: this.recapOn, present: false, busy: this.busy, now, awayMs: AWAY_MS });
    if (d.kind === "never") return;
    if (d.kind === "wait") {
      this.recapTimer = setTimeout(() => this.armRecap(), d.ms);
      return;
    }
    void this.makeRecap();
  }

  private async makeRecap(): Promise<void> {
    const c = await this.host.connection();
    if (!c || !this.sessionId || this.busy) return;
    this.recapClock.recappedAfterTurn = this.recapClock.completedTurns;
    const r = await c.recap(this.sessionId).catch(() => ({ text: null }));
    if (!r.text) return;
    if (this.awaySince == null) this.post({ type: "recap", text: r.text });
    else this.recapReady = r.text;
  }

  /** The recap switch moved (Settings): remember it here so the timer follows. */
  setRecap(on: boolean): void {
    this.recapOn = on;
  }

  setActiveFile(item: ContextItem | null): void {
    this.post({ type: "active-file", item });
  }

  /** Open a screen or the model picker from a command or the status bar. */
  show(what: Extract<HostMessage, { type: "open" }>["what"]): void {
    this.post({ type: "open", what });
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.answerPermission(id, null);
    if (this.recapTimer) clearTimeout(this.recapTimer);
  }
}
