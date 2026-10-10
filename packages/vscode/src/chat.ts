/**
 * One chat: a webview (the side bar or an editor tab) and the Atlarix session
 * it is showing. Turns what the user does into ACP requests and what the agent
 * sends into messages the webview draws.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { recapDecision, type RecapClock } from "@/lib/recap/rules";
import { isAuthRequired, type AtlarixConnection } from "./connection";
import type { DiffDocuments } from "./diff";
import type { ContextItem, HostMessage, ViewMessage } from "./protocol";

export interface ChatHost {
  connection(): Promise<AtlarixConnection | null>;
  workspace(): string | null;
  diffs: DiffDocuments;
  openInTab(sessionId: string | null): void;
  showLog(): void;
  signIn(): Promise<void>;
}

interface Pending {
  resolve: (r: RequestPermissionResponse) => void;
  diffDocs: vscode.Uri[];
  diff: { path: string; oldText: string | null; newText: string } | null;
}

const AWAY_MS = 3 * 60_000;

export class Chat {
  sessionId: string | null = null;
  private busy = false;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private peerWaiting = false;
  private readonly recapClock: RecapClock = { completedTurns: 0, lastTurnEndedAt: null, recappedAfterTurn: -1 };
  private awaySince: number | null = null;
  private recapTimer: ReturnType<typeof setTimeout> | null = null;
  private recapReady: string | null = null;
  private recapOn = true;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly host: ChatHost,
    private readonly startWith: string | null = null,
  ) {
    webview.onDidReceiveMessage((m: ViewMessage) => void this.onMessage(m));
  }

  private post(m: HostMessage): void {
    void this.webview.postMessage(m);
  }

  private async onMessage(m: ViewMessage): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          this.post({ type: "host-info", appName: vscode.env.appName, version: vscode.version });
          await this.open(this.startWith);
          return;
        case "send":
          return this.send(m.text, m.context, m.answers);
        case "cancel":
          if (this.sessionId) (await this.host.connection())?.cancel(this.sessionId);
          return;
        case "set-mode":
        case "set-model": {
          const c = await this.host.connection();
          if (!c || !this.sessionId) return;
          const configOptions = await c.setOption(this.sessionId, m.type === "set-mode" ? "mode" : "model", m.type === "set-mode" ? m.mode : m.value);
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
        case "history":
          return this.history();
        case "load-session":
          return this.open(m.sessionId);
        case "pick-file":
          return this.pickFile();
        case "open-file": {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.path));
          const line = Math.max(0, (m.line ?? 1) - 1);
          await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
          return;
        }
        case "sign-in":
          await this.host.signIn();
          return this.open(this.sessionId);
        case "open-in-tab":
          this.host.openInTab(this.sessionId);
          return;
        case "visible":
          return this.onVisibility(m.visible && m.focused);
        case "recap-setting": {
          this.recapOn = m.on;
          await (await this.host.connection())?.setRecap(m.on).catch(() => {});
          return;
        }
        case "show-log":
          this.host.showLog();
          return;
      }
    } catch (e) {
      this.post({ type: "turn-end", stopReason: null, error: (e as Error).message ?? String(e) });
    }
  }

  /** Start a chat, or load a past one into this view. */
  async open(sessionId: string | null): Promise<void> {
    const cwd = this.host.workspace();
    if (!cwd) return this.post({ type: "status", status: "no-folder" });
    this.post({ type: "status", status: "starting" });
    const c = await this.host.connection();
    if (!c) return;
    if (this.sessionId) c.forget(this.sessionId);
    for (const id of [...this.pending.keys()]) this.answerPermission(id, null);
    try {
      const listener = {
        update: (n: SessionNotification) => this.onUpdate(n),
        permission: (req: RequestPermissionRequest) => this.onPermission(req),
        peerWaiting: () => this.onPeerWaiting(),
      };
      if (sessionId) {
        // Listen first: the replay arrives as updates while load is answered.
        this.sessionId = sessionId;
        c.listen(sessionId, listener);
        this.post({ type: "session", sessionId, title: null, modes: null, configOptions: [], replay: true });
        const r = await c.loadSession(cwd, sessionId);
        this.post({ type: "session", sessionId, title: null, modes: r?.modes ?? null, configOptions: r?.configOptions ?? [], replay: false });
      } else {
        const r = await c.newSession(cwd);
        this.sessionId = r.sessionId;
        c.listen(r.sessionId, listener);
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
      this.post({ type: "status", status: "error", detail: (e as Error).message ?? String(e) });
    }
  }

  private onUpdate(n: SessionNotification): void {
    this.post({ type: "update", update: n.update });
  }

  private blocks(text: string, context: ContextItem[]): ContentBlock[] {
    const out: ContentBlock[] = [];
    if (text.trim()) out.push({ type: "text", text });
    for (const item of context) {
      const uri = pathToFileURL(item.path).href;
      if (item.text != null) {
        const lines = item.startLine ? `Lines ${item.startLine}–${item.endLine ?? item.startLine}:\n` : "";
        out.push({ type: "resource", resource: { uri, text: `${lines}${item.text}`, mimeType: "text/plain" } });
      } else {
        out.push({ type: "resource_link", uri, name: path.basename(item.path) });
      }
    }
    return out;
  }

  private async send(text: string, context: ContextItem[], answers?: string[], meta?: Record<string, unknown>): Promise<void> {
    if (this.busy) return;
    const c = await this.host.connection();
    if (!c || !this.sessionId) return;
    this.busy = true;
    this.recapReady = null;
    const sessionId = this.sessionId;
    try {
      const r = await c.prompt(sessionId, this.blocks(text, context), answers?.length ? { answers, ...meta } : meta);
      this.post({ type: "turn-end", stopReason: r.stopReason });
    } catch (e) {
      if (isAuthRequired(e)) this.post({ type: "status", status: "signed-out" });
      this.post({ type: "turn-end", stopReason: null, error: (e as Error).message ?? String(e) });
    } finally {
      this.busy = false;
      this.recapClock.completedTurns++;
      this.recapClock.lastTurnEndedAt = Date.now();
      if (this.peerWaiting) this.onPeerWaiting();
      else if (this.awaySince != null) this.armRecap();
    }
  }

  /** Another session messaged this one while it was idle: read it now, as the app does. */
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

  private answerPermission(requestId: string, optionId: string | null): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    void this.host.diffs.close(p.diffDocs);
    p.resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    this.post({ type: "permission-done", requestId });
  }

  private async history(): Promise<void> {
    const c = await this.host.connection();
    const cwd = this.host.workspace();
    if (!c || !cwd) return;
    const r = await c.listSessions(cwd);
    this.post({
      type: "sessions",
      sessions: r.sessions.map((s) => ({ sessionId: s.sessionId, title: s.title ?? null, updatedAt: s.updatedAt ?? "" })),
    });
  }

  private async pickFile(): Promise<void> {
    const root = this.host.workspace();
    const files = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out,build}/**", 5000);
    const picked = await vscode.window.showQuickPick(
      files.map((f) => ({ label: root ? path.relative(root, f.fsPath) : f.fsPath, uri: f })),
      { placeHolder: "Add a file to the chat", matchOnDescription: true },
    );
    if (picked) this.post({ type: "add-context", item: { path: picked.uri.fsPath, label: picked.label } });
  }

  addContext(item: ContextItem): void {
    this.post({ type: "add-context", item });
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

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.answerPermission(id, null);
    if (this.recapTimer) clearTimeout(this.recapTimer);
  }
}
