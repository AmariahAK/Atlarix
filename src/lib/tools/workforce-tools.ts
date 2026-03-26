/**
 * Workforce tools — v4.0
 * Slack, Jira, Linear, Sentry, Calendar, CI. Use Token Vault for auth.
 * Read-only tools: Ask mode. Write/trigger tools: Build with approval.
 */

import {
  ToolRegistry,
  ToolCategory,
  arrayParam,
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

type WorkforceWriteAction =
  | "post_to_slack"
  | "update_ticket_status"
  | "create_ticket"
  | "trigger_pipeline"
  | "cancel_pipeline";

function requestWorkforceApproval(params: {
  action: WorkforceWriteAction;
  service: string;
  description: string;
  payload: Record<string, unknown>;
}) {
  return {
    __permission_required: true,
    operation: "workforce_action",
    preview: {
      service: params.service,
      action: params.action,
      description: params.description,
      payload: params.payload,
    },
    metadata: {
      reasoning: "This workforce action can send updates or trigger external systems.",
    },
  };
}

// ─── Slack ─────────────────────────────────────────────────────────────────
ToolRegistry.register({
  name: "request_workspace_permissions",
  description:
    "Request Token Auth for multiple workforce services in one unified panel. Excludes already connected services automatically.",
  category: ToolCategory.WORKFORCE,
  cost: workforceCost,
  requiresWorkspace: false,
  isReadOnly: true,
  parameters: createParameters(
    {
      services: arrayParam(
        "string",
        "Required service IDs (e.g. slack, jira, linear, sentry, notion, google_calendar, gitlab, bitbucket).",
      ),
      reason: stringParam("Short reason to show the user before requesting access."),
    },
    ["services"],
  ),
  handler: async (args: any) => {
    const requested = Array.isArray(args?.services)
      ? args.services.map((s: unknown) => String(s).toLowerCase()).filter(Boolean)
      : [];
    const uniqueRequested: string[] = Array.from(new Set(requested));
    if (uniqueRequested.length === 0) {
      return { success: false, error: "services[] is required." };
    }
    const connected = await TokenVault.listConnectedServices();
    const connectedSet = new Set<string>(connected.map((s) => String(s.name).toLowerCase()));
    const missing = uniqueRequested.filter((svc) => !connectedSet.has(svc));
    if (missing.length === 0) {
      return {
        success: true,
        result: "All requested services are already connected in this session.",
        alreadyConnected: uniqueRequested,
      };
    }
    return {
      __workspace_permissions_requested: true,
      services: missing,
      alreadyConnected: uniqueRequested.filter((svc) => connectedSet.has(svc)),
      message:
        typeof args?.reason === "string" && args.reason.trim().length > 0
          ? args.reason.trim()
          : `The assistant needs access to: ${missing.join(", ")}.`,
    };
  },
});

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
    if (!args?.channelId || !args?.text) return { success: false, error: "channelId and text required." };
    return requestWorkforceApproval({
      action: "post_to_slack",
      service: "slack",
      description: `Post a Slack message to channel ${args.channelId}.`,
      payload: { channelId: args.channelId, text: args.text },
    });
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
    if (!args?.ticketId || !args?.status) {
      return { success: false, error: "ticketId and status are required." };
    }
    return requestWorkforceApproval({
      action: "update_ticket_status",
      service: source === "linear" ? "linear" : "jira",
      description: `Update ${source} ticket ${args.ticketId} to status "${args.status}".`,
      payload: { source, ticketId: args.ticketId, status: args.status },
    });
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
    if (!args?.title) return { success: false, error: "title is required." };
    return requestWorkforceApproval({
      action: "create_ticket",
      service: source === "linear" ? "linear" : "jira",
      description: `Create ${source} ticket "${args.title}".`,
      payload: {
        source,
        title: args.title,
        description: args.description ?? "",
        projectId: args.projectId ?? "",
      },
    });
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
    if (!args?.provider || !args?.owner || !args?.repo || !args?.ref) {
      return { success: false, error: "provider, owner, repo, and ref are required." };
    }
    return requestWorkforceApproval({
      action: "trigger_pipeline",
      service: String(args.provider).toLowerCase(),
      description: `Trigger ${args.provider} pipeline for ${args.owner}/${args.repo} @ ${args.ref}.`,
      payload: {
        provider: args.provider,
        owner: args.owner,
        repo: args.repo,
        ref: args.ref,
        workflowId: args.workflowId ?? "",
      },
    });
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
    if (!args?.provider || !args?.owner || !args?.repo || !args?.runId) {
      return { success: false, error: "provider, owner, repo, and runId are required." };
    }
    return requestWorkforceApproval({
      action: "cancel_pipeline",
      service: String(args.provider).toLowerCase(),
      description: `Cancel ${args.provider} pipeline run ${args.runId} for ${args.owner}/${args.repo}.`,
      payload: {
        provider: args.provider,
        owner: args.owner,
        repo: args.repo,
        runId: args.runId,
      },
    });
  },
});
