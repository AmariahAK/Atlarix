/**
 * Workforce Workspace Context — v4.0
 * Assembles data from connected extensions into a compact block (<300 tokens)
 * for injection after system prompt, before history. Workforce tier only.
 */

import log from "electron-log";
import { SubscriptionManager } from "../SubscriptionManager";
import { getAllWorkforceExtensions } from "./index";
import type { WorkspaceContextData } from "./types";

const logger = log.scope("workforce-workspace-context");
const MAX_TOKENS = 300;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function formatBlock(data: WorkspaceContextData): string {
  const lines: string[] = ["## Workspace context (Workforce)"];
  if (data.openPRs?.length) {
    lines.push(`Open PRs: ${data.openPRs.slice(0, 5).join("; ")}${data.openPRs.length > 5 ? "…" : ""}`);
  }
  if (data.failingPipelines?.length) {
    lines.push(`Failing pipelines: ${data.failingPipelines.slice(0, 5).join("; ")}${data.failingPipelines.length > 5 ? "…" : ""}`);
  }
  if (data.assignedTickets?.length) {
    lines.push(`Assigned tickets: ${data.assignedTickets.slice(0, 5).join("; ")}${data.assignedTickets.length > 5 ? "…" : ""}`);
  }
  if (data.unreadMentions?.length) {
    lines.push(`Unread mentions: ${data.unreadMentions.slice(0, 5).join("; ")}${data.unreadMentions.length > 5 ? "…" : ""}`);
  }
  if (data.recentSentryErrors?.length) {
    lines.push(`Recent errors: ${data.recentSentryErrors.slice(0, 3).join("; ")}${data.recentSentryErrors.length > 3 ? "…" : ""}`);
  }
  if (data.todaysMeetings?.length) {
    lines.push(`Today's meetings: ${data.todaysMeetings.slice(0, 5).join("; ")}${data.todaysMeetings.length > 5 ? "…" : ""}`);
  }
  if (data.lastUpdated) {
    lines.push(`Last updated: ${data.lastUpdated}`);
  }
  if (lines.length === 1) {
    return "";
  }
  return lines.join("\n");
}

/**
 * Build the Workforce workspace context block. Returns null if not Workforce tier
 * or no data. Call from chat stream when building system prompt (after main prompt, before history).
 */
export async function buildWorkforceWorkspaceContextBlock(): Promise<string | null> {
  if (SubscriptionManager.getEffectiveTier() !== "workforce") {
    return null;
  }

  const extensions = getAllWorkforceExtensions();
  const connected = await Promise.all(
    extensions.map(async (ext) => ({ ext, connected: await ext.isConnected() }))
  ).then((pairs) => pairs.filter((p) => p.connected).map((p) => p.ext));

  if (connected.length === 0) {
    return null;
  }

  const results = await Promise.allSettled(
    connected.map(async (ext) => {
      if (!ext.getContextData) return {};
      try {
        return await ext.getContextData!();
      } catch (err) {
        logger.warn(`[WorkspaceContext] ${ext.service} getContextData failed:`, err);
        return {};
      }
    })
  );

  const merged: WorkspaceContextData = {
    lastUpdated: new Date().toISOString(),
  };
  for (const r of results) {
    if (r.status === "fulfilled" && r.value && typeof r.value === "object") {
      const v = r.value as Partial<WorkspaceContextData>;
      if (v.openPRs?.length) merged.openPRs = [...(merged.openPRs ?? []), ...v.openPRs];
      if (v.failingPipelines?.length) merged.failingPipelines = [...(merged.failingPipelines ?? []), ...v.failingPipelines];
      if (v.assignedTickets?.length) merged.assignedTickets = [...(merged.assignedTickets ?? []), ...v.assignedTickets];
      if (v.unreadMentions?.length) merged.unreadMentions = [...(merged.unreadMentions ?? []), ...v.unreadMentions];
      if (v.recentSentryErrors?.length) merged.recentSentryErrors = [...(merged.recentSentryErrors ?? []), ...v.recentSentryErrors];
      if (v.todaysMeetings?.length) merged.todaysMeetings = [...(merged.todaysMeetings ?? []), ...v.todaysMeetings];
    }
  }

  const hasData =
    (merged.openPRs?.length ?? 0) > 0 ||
    (merged.failingPipelines?.length ?? 0) > 0 ||
    (merged.assignedTickets?.length ?? 0) > 0 ||
    (merged.unreadMentions?.length ?? 0) > 0 ||
    (merged.recentSentryErrors?.length ?? 0) > 0 ||
    (merged.todaysMeetings?.length ?? 0) > 0;
  if (!hasData) {
    return null;
  }

  let block = formatBlock(merged);
  if (estimateTokens(block) > MAX_TOKENS) {
    block = block.slice(0, MAX_TOKENS * CHARS_PER_TOKEN);
    const lastNewline = block.lastIndexOf("\n");
    if (lastNewline > 0) block = block.slice(0, lastNewline + 1);
    block += "\n…(truncated)";
  }
  try {
    const { capture } = await import("../../main/lib/analytics");
    capture("workspace_context_built", { extensionCount: connected.length });
  } catch { /* non-fatal */ }
  return "\n\n" + block;
}
