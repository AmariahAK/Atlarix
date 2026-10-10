/**
 * An edit waiting for Allow/Deny, opened in VS Code's own side-by-side diff.
 *
 * The approval carries the file before and after (ACP's diff block), so both
 * sides are served from memory under our own scheme: nothing touches the file
 * until the user says yes, and the agent writes it then.
 */
import * as vscode from "vscode";

export const DIFF_SCHEME = "atlarix-diff";

export class DiffDocuments implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  private put(key: string, side: "before" | "after", filePath: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: filePath, query: `${key}&${side}` });
    this.docs.set(uri.toString(), text);
    this.changed.fire(uri);
    return uri;
  }

  /** Open the proposed change; returns the two documents so they can be closed after. */
  async show(key: string, filePath: string, before: string | null, after: string): Promise<vscode.Uri[]> {
    const left = this.put(key, "before", filePath, before ?? "");
    const right = this.put(key, "after", filePath, after);
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    await vscode.commands.executeCommand("vscode.diff", left, right, `${name} — Atlarix's change (not yet applied)`, {
      preview: true,
      preserveFocus: true,
    });
    return [left, right];
  }

  /** Close the diff tabs for these documents and forget them. */
  async close(uris: readonly vscode.Uri[]): Promise<void> {
    const keys = new Set(uris.map((u) => u.toString()));
    for (const k of keys) this.docs.delete(k);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const mine = tabs.filter((t) => {
      const input = t.input as { original?: vscode.Uri; modified?: vscode.Uri } | undefined;
      return (input?.original && keys.has(input.original.toString())) || (input?.modified && keys.has(input.modified.toString()));
    });
    if (mine.length) await vscode.window.tabGroups.close(mine, true);
  }
}
