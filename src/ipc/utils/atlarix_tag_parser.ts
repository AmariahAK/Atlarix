import { normalizePath } from "../../../shared/normalizePath";
import log from "electron-log";

const logger = log.scope("atlarix_tag_parser");

export function getAtlarixWriteTags(fullResponse: string): {
  path: string;
  content: string;
  description?: string;
}[] {
  const atlarixWriteRegex =
    /<atlarix-write([^>]*)>([\s\S]*?)<\/atlarix-write>/gi;
  const pathRegex = /path="([^"]+)"/;
  const descriptionRegex = /description="([^"]+)"/;

  let match;
  const tags: { path: string; content: string; description?: string }[] = [];

  while ((match = atlarixWriteRegex.exec(fullResponse)) !== null) {
    const attributesString = match[1];
    let content = match[2].trim();

    const pathMatch = pathRegex.exec(attributesString);
    const descriptionMatch = descriptionRegex.exec(attributesString);

    if (pathMatch && pathMatch[1]) {
      const path = pathMatch[1];
      const description = descriptionMatch?.[1];

      const contentLines = content.split("\n");
      if (contentLines[0]?.startsWith("```")) {
        contentLines.shift();
      }
      if (contentLines[contentLines.length - 1]?.startsWith("```")) {
        contentLines.pop();
      }
      content = contentLines.join("\n");

      tags.push({ path: normalizePath(path), content, description });
    } else {
      logger.warn(
        "Found <atlarix-write> tag without a valid 'path' attribute:",
        match[0],
      );
    }
  }
  return tags;
}

export function getAtlarixRenameTags(fullResponse: string): {
  from: string;
  to: string;
}[] {
  const atlarixRenameRegex =
    /<atlarix-rename from="([^"]+)" to="([^"]+)"[^>]*>([\s\S]*?)<\/atlarix-rename>/g;
  let match;
  const tags: { from: string; to: string }[] = [];
  while ((match = atlarixRenameRegex.exec(fullResponse)) !== null) {
    tags.push({
      from: normalizePath(match[1]),
      to: normalizePath(match[2]),
    });
  }
  return tags;
}

export function getAtlarixDeleteTags(fullResponse: string): string[] {
  const atlarixDeleteRegex =
    /<atlarix-delete path="([^"]+)"[^>]*>([\s\S]*?)<\/atlarix-delete>/g;
  let match;
  const paths: string[] = [];
  while ((match = atlarixDeleteRegex.exec(fullResponse)) !== null) {
    paths.push(normalizePath(match[1]));
  }
  return paths;
}

export function getAtlarixChatSummaryTag(fullResponse: string): string | null {
  const atlarixChatSummaryRegex =
    /<atlarix-chat-summary>([\s\S]*?)<\/atlarix-chat-summary>/g;
  const match = atlarixChatSummaryRegex.exec(fullResponse);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

export function getAtlarixCommandTags(fullResponse: string): string[] {
  const atlarixCommandRegex =
    /<atlarix-command type="([^"]+)"[^>]*><\/atlarix-command>/g;
  let match;
  const commands: string[] = [];

  while ((match = atlarixCommandRegex.exec(fullResponse)) !== null) {
    commands.push(match[1]);
  }

  return commands;
}
