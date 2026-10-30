/** Moving between screens: the chat, and the pages over it (history, account, MCP, settings…). */
export type View =
  | { name: "chat" }
  | { name: "history" }
  | { name: "undo" }
  | { name: "account" }
  | { name: "usage" }
  | { name: "mcp" }
  | { name: "automations" }
  | { name: "settings"; tab?: "keys" | "approve" | "browser" | "general" }
  | { name: "provider"; id: string }
  | { name: "add-provider"; focus?: string };

export interface Nav {
  go(v: View): void;
  /** Back to where this page was opened from (the chat at the bottom). */
  back(): void;
}
