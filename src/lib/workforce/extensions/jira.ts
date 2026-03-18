/**
 * Jira — Workforce extension (Token Vault).
 * Scopes: read/write jira-work
 */

import { createWorkforceExtension } from "../create-extension";
import * as TokenVault from "../../auth/TokenVaultService";
import * as JiraApi from "../jira-api";

export const jiraExtension = createWorkforceExtension(
  "Jira",
  "jira",
  ["read:jira-work", "write:jira-work"],
  {
    async getContextData() {
      const token = await TokenVault.getToken("jira", ["read:jira-work"]);
      if (!token) return {};
      try {
        const assignedTickets = await JiraApi.fetchAssignedTickets(token);
        return { assignedTickets };
      } catch {
        return {};
      }
    },
  }
);
