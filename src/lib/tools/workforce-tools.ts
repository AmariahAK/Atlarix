/**
 * Workforce tools — v4.0
 * Slack, Jira, Linear, Sentry, Calendar, CI. Use Token Vault for auth.
 * Read-only tools: Ask mode. Write/trigger tools: Build with approval.
 */

import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
} from "./registry";
import * as TokenVault from "../auth/TokenVaultService";
import * as SlackApi from "../workforce/slack-api";
import * as JiraApi from "../workforce/jira-api";

const workforceCost = 2;

function notConnected(service: string): string {
  return `${service} is not connected. Connect it in Settings → Workforce extensions.`;
}

// ─── Slack ─────────────────────────────────────────────────────────────────
ToolRegistry.register({
  name: "get_slack_mentions",
  description: "Get unread mentions from Slack for the authenticated user. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: true,
  parameters: createParameters(
    { channelId: stringParam("Optional channel ID to filter by") },
    []
  ),
  handler: async () => {
    const token = await TokenVault.getToken("slack", ["channels:read", "im:read", "users:read"]);
    if (!token) return notConnected("Slack");
    try {
      const mentions = await SlackApi.fetchUnreadMentions(token);
      if (mentions.length === 0) return "No unread mentions in Slack.";
      return `Unread: ${mentions.join("; ")}`;
    } catch (e) {
      return `Slack API error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

ToolRegistry.register({
  name: "get_slack_channel",
  description: "Get Slack channel info and recent messages. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: true,
  parameters: createParameters(
    { channelId: stringParam("Channel ID") },
    ["channelId"]
  ),
  handler: async (args: any) => {
    const token = await TokenVault.getToken("slack", ["channels:read", "chat:write"]);
    if (!token) return notConnected("Slack");
    if (!args?.channelId) return "channelId is required.";
    try {
      const info = await SlackApi.fetchChannelInfo(token, args.channelId);
      const lines = [`Channel: ${info.name ?? args.channelId}`];
      if (info.messages?.length) lines.push("Recent messages:", ...info.messages.slice(0, 15));
      return lines.join("\n");
    } catch (e) {
      return `Slack API error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

ToolRegistry.register({
  name: "post_to_slack",
  description: "Post a message to a Slack channel. Requires approval. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      channelId: stringParam("Channel ID"),
      text: stringParam("Message text"),
    },
    ["channelId", "text"]
  ),
  handler: async (args: any) => {
    const token = await TokenVault.getToken("slack", ["chat:write"]);
    if (!token) return notConnected("Slack");
    if (!args?.channelId || !args?.text) return { success: false, error: "channelId and text required." };
    try {
      const result = await SlackApi.postMessage(token, args.channelId, args.text);
      if (result.ok) return { success: true, message: "Message posted." };
      return { success: false, error: result.error ?? "Failed to post" };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ─── Jira / Linear ───────────────────────────────────────────────────────────
ToolRegistry.register({
  name: "get_assigned_tickets",
  description: "Get tickets assigned to the current user from Jira or Linear. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: true,
  parameters: createParameters(
    { source: stringParam("'jira' or 'linear'") },
    []
  ),
  handler: async (args: any) => {
    const source = (args?.source ?? "jira").toLowerCase();
    if (source === "linear") {
      const token = await TokenVault.getToken("linear", ["read"]);
      if (!token) return notConnected("Linear");
      return "Assigned Linear issues (Linear API integration pending).";
    }
    const token = await TokenVault.getToken("jira", ["read:jira-work"]);
    if (!token) return notConnected("Jira");
    try {
      const tickets = await JiraApi.fetchAssignedTickets(token);
      if (tickets.length === 0) return "No assigned Jira tickets.";
      return tickets.join("\n");
    } catch (e) {
      return `Jira API error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

ToolRegistry.register({
  name: "update_ticket_status",
  description: "Update status of a Jira or Linear ticket. Requires approval. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      source: stringParam("'jira' or 'linear'"),
      ticketId: stringParam("Ticket ID or key"),
      status: stringParam("New status"),
    },
    ["source", "ticketId", "status"]
  ),
  handler: async (args: any) => {
    const source = (args?.source ?? "jira").toLowerCase();
    const token = source === "linear"
      ? await TokenVault.getToken("linear", ["write"])
      : await TokenVault.getToken("jira", ["write:jira-work"]);
    if (!token) return notConnected(source === "linear" ? "Linear" : "Jira");
    return { success: true, message: `Ticket ${args.ticketId} status update (approval flow pending).` };
  },
});

ToolRegistry.register({
  name: "create_ticket",
  description: "Create a new Jira or Linear ticket. Requires approval. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      source: stringParam("'jira' or 'linear'"),
      title: stringParam("Title"),
      description: stringParam("Optional description"),
      projectId: stringParam("Optional project/team ID"),
    },
    ["source", "title"]
  ),
  handler: async (args: any) => {
    const source = (args?.source ?? "jira").toLowerCase();
    const token = source === "linear"
      ? await TokenVault.getToken("linear", ["write"])
      : await TokenVault.getToken("jira", ["write:jira-work"]);
    if (!token) return notConnected(source === "linear" ? "Linear" : "Jira");
    return { success: true, message: `Create ticket "${args.title}" (approval flow pending).` };
  },
});

ToolRegistry.register({
  name: "get_sprint_status",
  description: "Get current sprint status from Jira or Linear. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: true,
  parameters: createParameters(
    { source: stringParam("'jira' or 'linear'"), boardId: stringParam("Optional board/team ID") },
    []
  ),
  handler: async (args: any) => {
    const source = (args?.source ?? "jira").toLowerCase();
    const token = source === "linear"
      ? await TokenVault.getToken("linear", ["read"])
      : await TokenVault.getToken("jira", ["read:jira-work"]);
    if (!token) return notConnected(source === "linear" ? "Linear" : "Jira");
    return "Sprint status (API integration pending).";
  },
});

// ─── Sentry ──────────────────────────────────────────────────────────────────
ToolRegistry.register({
  name: "get_sentry_errors",
  description: "Get recent errors from Sentry, optionally filtered by project/file/time. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: true,
  parameters: createParameters(
    {
      projectSlug: stringParam("Optional project slug"),
      fileFilter: stringParam("Optional file path filter"),
      limit: { type: "number", description: "Max number of events (default 10)" },
    },
    []
  ),
  handler: async () => {
    const token = await TokenVault.getToken("sentry", ["project:read", "event:read"]);
    if (!token) return notConnected("Sentry");
    return "No recent errors (Sentry API integration pending).";
  },
});

ToolRegistry.register({
  name: "get_sentry_error_detail",
  description: "Get full detail for a specific Sentry error event. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: true,
  parameters: createParameters(
    { eventId: stringParam("Sentry event ID") },
    ["eventId"]
  ),
  handler: async (args: any) => {
    const token = await TokenVault.getToken("sentry", ["event:read"]);
    if (!token) return notConnected("Sentry");
    return `Event ${args.eventId} detail (Sentry API integration pending).`;
  },
});

// ─── Calendar ───────────────────────────────────────────────────────────────
ToolRegistry.register({
  name: "get_today_schedule",
  description: "Get today's meetings from Google Calendar. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: true,
  parameters: createParameters({}, []),
  handler: async () => {
    const token = await TokenVault.getToken("google_calendar", ["https://www.googleapis.com/auth/calendar.readonly"]);
    if (!token) return notConnected("Google Calendar");
    return "No meetings today (Calendar API integration pending).";
  },
});

// ─── CI (trigger/cancel) ────────────────────────────────────────────────────
ToolRegistry.register({
  name: "trigger_pipeline",
  description: "Trigger a CI pipeline (GitHub Actions, GitLab CI, or Bitbucket). Requires approval. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      provider: stringParam("'github' | 'gitlab' | 'bitbucket'"),
      owner: stringParam("Owner or workspace"),
      repo: stringParam("Repository name"),
      ref: stringParam("Branch or ref (e.g. main)"),
      workflowId: stringParam("Optional workflow file or pipeline ID"),
    },
    ["provider", "owner", "repo", "ref"]
  ),
  handler: async (args: any) => {
    const provider = (args?.provider ?? "github").toLowerCase();
    if (provider === "gitlab") {
      const t = await TokenVault.getToken("gitlab", ["read_api", "read_repository"]);
      if (!t) return notConnected("GitLab");
    } else if (provider === "bitbucket") {
      const t = await TokenVault.getToken("bitbucket", ["pipeline:read", "repository:read"]);
      if (!t) return notConnected("Bitbucket");
    }
    return { success: true, message: `Trigger pipeline (approval flow pending) for ${args.owner}/${args.repo} @ ${args.ref}.` };
  },
});

ToolRegistry.register({
  name: "cancel_pipeline",
  description: "Cancel a running CI pipeline. Requires approval. Workforce only.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      provider: stringParam("'github' | 'gitlab' | 'bitbucket'"),
      owner: stringParam("Owner or workspace"),
      repo: stringParam("Repository name"),
      runId: stringParam("Pipeline run ID"),
    },
    ["provider", "owner", "repo", "runId"]
  ),
  handler: async (args: any) => {
    const provider = (args?.provider ?? "github").toLowerCase();
    if (provider === "gitlab") {
      const t = await TokenVault.getToken("gitlab", ["read_api", "read_repository"]);
      if (!t) return notConnected("GitLab");
    } else if (provider === "bitbucket") {
      const t = await TokenVault.getToken("bitbucket", ["pipeline:read", "repository:read"]);
      if (!t) return notConnected("Bitbucket");
    }
    return { success: true, message: `Cancel pipeline run ${args.runId} (approval flow pending).` };
  },
});
