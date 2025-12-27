import { normalizePath } from "../../../shared/normalizePath";
import log from "electron-log";
import { SqlQuery } from "../../lib/schemas";

const logger = log.scope("atlarix_tag_parser");

export function getAtlarixWriteTags(fullResponse: string): {
  path: string;
  content: string;
  description?: string;
}[] {
  const dyadWriteRegex = /<atlarix-write([^>]*)>([\s\S]*?)<\/atlarix-write>/gi;
  const pathRegex = /path="([^"]+)"/;
  const descriptionRegex = /description="([^"]+)"/;

  let match;
  const tags: { path: string; content: string; description?: string }[] = [];

  while ((match = dyadWriteRegex.exec(fullResponse)) !== null) {
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
  const dyadRenameRegex =
    /<atlarix-rename from="([^"]+)" to="([^"]+)"[^>]*>([\s\S]*?)<\/atlarix-rename>/g;
  let match;
  const tags: { from: string; to: string }[] = [];
  while ((match = dyadRenameRegex.exec(fullResponse)) !== null) {
    tags.push({
      from: normalizePath(match[1]),
      to: normalizePath(match[2]),
    });
  }
  return tags;
}

export function getAtlarixDeleteTags(fullResponse: string): string[] {
  const dyadDeleteRegex =
    /<atlarix-delete path="([^"]+)"[^>]*>([\s\S]*?)<\/atlarix-delete>/g;
  let match;
  const paths: string[] = [];
  while ((match = dyadDeleteRegex.exec(fullResponse)) !== null) {
    paths.push(normalizePath(match[1]));
  }
  return paths;
}

export function getAtlarixAddDependencyTags(fullResponse: string): string[] {
  const dyadAddDependencyRegex =
    /<atlarix-add-dependency packages="([^"]+)">[^<]*<\/atlarix-add-dependency>/g;
  let match;
  const packages: string[] = [];
  while ((match = dyadAddDependencyRegex.exec(fullResponse)) !== null) {
    packages.push(...match[1].split(" "));
  }
  return packages;
}

export function getAtlarixChatSummaryTag(fullResponse: string): string | null {
  const dyadChatSummaryRegex =
    /<atlarix-chat-summary>([\s\S]*?)<\/atlarix-chat-summary>/g;
  const match = dyadChatSummaryRegex.exec(fullResponse);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

export function getAtlarixExecuteSqlTags(fullResponse: string): SqlQuery[] {
  const dyadExecuteSqlRegex =
    /<atlarix-execute-sql([^>]*)>([\s\S]*?)<\/atlarix-execute-sql>/g;
  const descriptionRegex = /description="([^"]+)"/;
  let match;
  const queries: { content: string; description?: string }[] = [];

  while ((match = dyadExecuteSqlRegex.exec(fullResponse)) !== null) {
    const attributesString = match[1] || "";
    let content = match[2].trim();
    const descriptionMatch = descriptionRegex.exec(attributesString);
    const description = descriptionMatch?.[1];

    // Handle markdown code blocks if present
    const contentLines = content.split("\n");
    if (contentLines[0]?.startsWith("```")) {
      contentLines.shift();
    }
    if (contentLines[contentLines.length - 1]?.startsWith("```")) {
      contentLines.pop();
    }
    content = contentLines.join("\n");

    queries.push({ content, description });
  }

  return queries;
}

export function getAtlarixCommandTags(fullResponse: string): string[] {
  const dyadCommandRegex =
    /<atlarix-command type="([^"]+)"[^>]*><\/atlarix-command>/g;
  let match;
  const commands: string[] = [];

  while ((match = dyadCommandRegex.exec(fullResponse)) !== null) {
    commands.push(match[1]);
  }

  return commands;
}

export function getAtlarixSearchReplaceTags(fullResponse: string): {
  path: string;
  content: string;
  description?: string;
}[] {
  const dyadSearchReplaceRegex =
    /<atlarix-search-replace([^>]*)>([\s\S]*?)<\/atlarix-search-replace>/gi;
  const pathRegex = /path="([^"]+)"/;
  const descriptionRegex = /description="([^"]+)"/;

  let match;
  const tags: { path: string; content: string; description?: string }[] = [];

  while ((match = dyadSearchReplaceRegex.exec(fullResponse)) !== null) {
    const attributesString = match[1] || "";
    let content = match[2].trim();

    const pathMatch = pathRegex.exec(attributesString);
    const descriptionMatch = descriptionRegex.exec(attributesString);

    if (pathMatch && pathMatch[1]) {
      const path = pathMatch[1];
      const description = descriptionMatch?.[1];

      // Handle markdown code fences if present
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
        "Found <atlarix-search-replace> tag without a valid 'path' attribute:",
        match[0],
      );
    }
  }
  return tags;
}
