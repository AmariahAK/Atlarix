/**
 * Google Chat — Workforce extension (Token Vault).
 * Read-only + chat.messages.create
 */

import { createWorkforceExtension } from "../create-extension";

export const googleChatExtension = createWorkforceExtension("Google Chat", "google_chat", [
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.messages.create",
]);
