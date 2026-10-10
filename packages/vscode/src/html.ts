/** The chat webview's page: our script and stylesheet, under a strict CSP. */
import * as vscode from "vscode";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function chatHtml(webview: vscode.Webview, root: vscode.Uri): string {
  const n = nonce();
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, "dist", "webview.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, "dist", "webview.css"));
  // Rix's own <style> sits inside his inline SVG, hence 'unsafe-inline' for
  // styles only. Scripts are ours alone (nonce); nothing loads from the web.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Atlarix</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}
