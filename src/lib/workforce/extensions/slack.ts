/**
 * Slack — Workforce extension (Token Vault).
 * Scopes: channels:read, chat:write, im:read, users:read
 */

import { createWorkforceExtension } from "../create-extension";
import * as TokenVault from "../../auth/TokenVaultService";
import * as SlackApi from "../slack-api";

export const slackExtension = createWorkforceExtension(
  "Slack",
  "slack",
  ["channels:read", "chat:write", "im:read", "users:read"],
  {
    async getContextData() {
      const token = await TokenVault.getToken("slack", ["channels:read", "im:read", "users:read"]);
      if (!token) return {};
      try {
        const unreadMentions = await SlackApi.fetchUnreadMentions(token);
        return { unreadMentions };
      } catch {
        return {};
      }
    },
  }
);
