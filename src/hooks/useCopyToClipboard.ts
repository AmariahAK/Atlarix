import { useState, useRef, useEffect } from "react";
import { getLanguage } from "@/utils/get_language";

const CUSTOM_TAG_NAMES = [
  "atlarix-write",
  "atlarix-rename",
  "atlarix-delete",
  "atlarix-execute-sql",
  "atlarix-add-integration",
  "atlarix-output",
  "atlarix-problem-report",
  "atlarix-chat-summary",
  "atlarix-edit",
  "atlarix-codebase-context",
  "think",
  "atlarix-command",
  // Tool-related tags (should be excluded from copy)
  "atlarix-tool-call",
  "atlarix-tool-result",
  "atlarix-mcp-tool-call",
  "atlarix-mcp-tool-result",
  "atlarix-web-search",
  "atlarix-web-crawl",
  "atlarix-web-search-result",
  "atlarix-code-search",
  "atlarix-code-search-result",
  "atlarix-read",
];
export const useCopyToClipboard = () => {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const copyMessageContent = async (messageContent: string) => {
    try {
      // Use the same parsing logic as AtlarixMarkdownParser but convert to clean text
      const formattedContent = convertAtlarixContentToMarkdown(messageContent);

      // Copy to clipboard
      await navigator.clipboard.writeText(formattedContent);

      setCopied(true);
      // Clear existing timeout if any
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Set new timeout and store reference
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
      return true;
    } catch (error) {
      console.error("Failed to copy content:", error);
      return false;
    }
  };

  // Convert Atlarix content to clean markdown using the same parsing logic as AtlarixMarkdownParser
  const convertAtlarixContentToMarkdown = (content: string): string => {
    if (!content) return "";

    // Use the same parsing functions from AtlarixMarkdownParser
    const contentPieces = parseCustomTags(content);

    let result = "";

    contentPieces.forEach((piece) => {
      if (piece.type === "markdown") {
        // Add regular markdown content as-is
        result += piece.content || "";
      } else {
        // Convert custom tags to markdown format
        const markdownVersion = convertCustomTagToMarkdown(piece.tagInfo);
        result += markdownVersion;
      }
    });

    // Clean up the final result
    return result
      .replace(/\n{3,}/g, "\n\n") // Max 2 consecutive newlines
      .trim();
  };

  // Convert individual custom tags to markdown (reuse the same logic from AtlarixMarkdownParser)
  const convertCustomTagToMarkdown = (tagInfo: any): string => {
    const { tag, attributes, content } = tagInfo;

    switch (tag) {
      // Exclude thinking and tool tags from copy output - user wants the response only
      case "think":
      case "atlarix-tool-call":
      case "atlarix-tool-result":
      case "atlarix-mcp-tool-call":
      case "atlarix-mcp-tool-result":
      case "atlarix-web-search":
      case "atlarix-web-crawl":
      case "atlarix-web-search-result":
      case "atlarix-code-search":
      case "atlarix-code-search-result":
      case "atlarix-read":
        return "";  // Don't include in copy output

      case "atlarix-write": {
        const writePath = attributes.path || "file";
        const writeDesc = attributes.description || "";
        const language = getLanguage(writePath);

        let writeResult = `### File: ${writePath}\n\n`;
        if (writeDesc && writeDesc !== writePath) {
          writeResult += `${writeDesc}\n\n`;
        }
        writeResult += `\`\`\`${language}\n${content}\n\`\`\`\n\n`;
        return writeResult;
      }

      case "atlarix-edit": {
        const editPath = attributes.path || "file";
        const editDesc = attributes.description || "";
        const editLang = getLanguage(editPath);

        let editResult = `### Edit: ${editPath}\n\n`;
        if (editDesc && editDesc !== editPath) {
          editResult += `${editDesc}\n\n`;
        }
        editResult += `\`\`\`${editLang}\n${content}\n\`\`\`\n\n`;
        return editResult;
      }

      case "atlarix-rename": {
        const from = attributes.from || "";
        const to = attributes.to || "";
        return `### Rename: ${from} → ${to}\n\n`;
      }

      case "atlarix-delete": {
        const deletePath = attributes.path || "";
        return `### Delete: ${deletePath}\n\n`;
      }

      case "atlarix-execute-sql": {
        const sqlDesc = attributes.description || "";
        let sqlResult = `### Execute SQL\n\n`;
        if (sqlDesc) {
          sqlResult += `${sqlDesc}\n\n`;
        }
        sqlResult += `\`\`\`sql\n${content}\n\`\`\`\n\n`;
        return sqlResult;
      }

      case "atlarix-add-integration": {
        const provider = attributes.provider || "";
        return `### Add Integration: ${provider}\n\n`;
      }

      case "atlarix-codebase-context": {
        const files = attributes.files || "";
        let contextResult = `### Codebase Context\n\n`;
        if (files) {
          contextResult += `Files: ${files}\n\n`;
        }
        contextResult += `\`\`\`\n${content}\n\`\`\`\n\n`;
        return contextResult;
      }

      case "atlarix-output": {
        const outputType = attributes.type || "info";
        const message = attributes.message || "";
        const emoji =
          outputType === "error"
            ? "❌"
            : outputType === "warning"
              ? "⚠️"
              : "ℹ️";

        let outputResult = `${emoji} **${outputType.toUpperCase()}**`;
        if (message) {
          outputResult += `: ${message}`;
        }
        if (content) {
          outputResult += `\n\n${content}`;
        }
        return outputResult + "\n\n";
      }

      case "atlarix-problem-report": {
        const summary = attributes.summary || "";
        let problemResult = `### Problem Report\n\n`;
        if (summary) {
          problemResult += `**Summary:** ${summary}\n\n`;
        }
        if (content) {
          problemResult += content;
        }
        return problemResult + "\n\n";
      }

      case "atlarix-chat-summary":
      case "atlarix-command":
        // Don't include these in copy
        return "";

      default:
        return content ? `${content}\n\n` : "";
    }
  };

  // Reuse the same parsing functions from AtlarixMarkdownParser but simplified
  const parseCustomTags = (content: string) => {
    const { processedContent } = preprocessUnclosedTags(content);

    const tagPattern = new RegExp(
      `<(${CUSTOM_TAG_NAMES.join("|")})\\s*([^>]*)>(.*?)<\\/\\1>`,
      "gs",
    );

    const contentPieces: any[] = [];
    let lastIndex = 0;
    let match;

    while ((match = tagPattern.exec(processedContent)) !== null) {
      const [fullMatch, tag, attributesStr, tagContent] = match;
      const startIndex = match.index;

      // Add markdown content before this tag
      if (startIndex > lastIndex) {
        contentPieces.push({
          type: "markdown",
          content: processedContent.substring(lastIndex, startIndex),
        });
      }

      // Parse attributes
      const attributes: Record<string, string> = {};
      const attrPattern = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
        attributes[attrMatch[1]] = attrMatch[2];
      }

      // Add the tag info
      contentPieces.push({
        type: "custom-tag",
        tagInfo: {
          tag,
          attributes,
          content: tagContent,
          fullMatch,
        },
      });

      lastIndex = startIndex + fullMatch.length;
    }

    // Add remaining markdown content
    if (lastIndex < processedContent.length) {
      contentPieces.push({
        type: "markdown",
        content: processedContent.substring(lastIndex),
      });
    }

    return contentPieces;
  };

  // Simplified version of preprocessUnclosedTags
  const preprocessUnclosedTags = (content: string) => {
    let processedContent = content;

    for (const tagName of CUSTOM_TAG_NAMES) {
      const openTagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
      const closeTagPattern = new RegExp(`</${tagName}>`, "g");

      const openCount = (processedContent.match(openTagPattern) || []).length;
      const closeCount = (processedContent.match(closeTagPattern) || []).length;

      const missingCloseTags = openCount - closeCount;
      if (missingCloseTags > 0) {
        processedContent += Array(missingCloseTags)
          .fill(`</${tagName}>`)
          .join("");
      }
    }

    return { processedContent };
  };

  return { copyMessageContent, copied };
};
