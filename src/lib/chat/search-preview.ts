/**
 * A saved message as a search result previews it: the words, not the markup
 * the chat stores around tool calls and thinking (QA 15.7.1 #11: ⌘K showed
 * `<atlarix-tool-call tool="mcp_servers" …> {"operation":…`).
 */
export function searchPreviewText(content: string): string {
  return content
    .replace(/<(atlarix-[\w-]+|think)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:atlarix-[\w-]+|think)\b[^>]*>?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
