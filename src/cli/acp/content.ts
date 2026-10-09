/**
 * An editor's prompt (ACP ContentBlocks) as what `AgentSession.submit` takes:
 * one text, plus images written to files.
 *
 * Files the user attached arrive as embedded resources (their text inline) or
 * as links (a path only). Inline text goes in under its path, the way a pasted
 * file reads; a link becomes `@file:<path>`, which the agent's own file mention
 * already resolves. Images are saved to a scratch folder, since the CLI attaches
 * images by path.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";

export interface PromptInput {
  text: string;
  images: Array<{ path: string; mime: string; label: string }>;
}

/** A file URI as a path on this OS: `file:///C:/x` is `C:\\x` on Windows, not `/C:/x`. */
function filePath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri.slice("file://".length);
    }
  }
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** `@file:` takes a path relative to the workspace (parseContextMentions). */
function mention(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  // Mentions are written with forward slashes on every OS.
  return `@file:${rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : p}`;
}

export function promptInput(
  blocks: readonly ContentBlock[],
  cwd: string,
  scratchDir = path.join(os.tmpdir(), "atlarix-acp"),
): PromptInput {
  const parts: string[] = [];
  const images: PromptInput["images"] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(mention(filePath(b.uri), cwd));
    else if (b.type === "resource") {
      const r = b.resource as { uri: string; text?: string };
      const where = filePath(r.uri);
      parts.push(typeof r.text === "string" ? `[${where}]\n${r.text}` : mention(where, cwd));
    } else if (b.type === "image") {
      fs.mkdirSync(scratchDir, { recursive: true });
      const file = path.join(scratchDir, `image-${Date.now()}-${images.length}.${EXT[b.mimeType] ?? "png"}`);
      fs.writeFileSync(file, Buffer.from(b.data, "base64"));
      images.push({ path: file, mime: b.mimeType, label: b.uri ? path.basename(filePath(b.uri)) : `image ${images.length + 1}` });
    }
    // Audio: not taken (promptCapabilities.audio is false), so never sent.
  }
  return { text: parts.join("\n\n").trim(), images };
}
