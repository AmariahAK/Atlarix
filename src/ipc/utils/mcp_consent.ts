import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { db } from "../../db";
import { mcpToolConsents } from "../../db/schema";
import { and, eq } from "drizzle-orm";

export type Consent = "ask" | "always" | "denied";

const pendingConsentResolvers = new Map<
  string,
  (d: "accept-once" | "accept-always" | "decline") => void
>();

export function resolveConsent(
  requestId: string,
  decision: "accept-once" | "accept-always" | "decline",
) {
  const resolver = pendingConsentResolvers.get(requestId);
  if (resolver) {
    pendingConsentResolvers.delete(requestId);
    resolver(decision);
  }
}

export async function getStoredConsent(
  serverId: number,
  toolName: string,
): Promise<Consent> {
  const rows = await db
    .select()
    .from(mcpToolConsents)
    .where(
      and(
        eq(mcpToolConsents.serverId, serverId),
        eq(mcpToolConsents.toolName, toolName),
      ),
    );
  if (rows.length === 0) return "ask";
  return (rows[0].consent as Consent) ?? "ask";
}

async function setStoredConsent(
  serverId: number,
  toolName: string,
  consent: Consent,
): Promise<void> {
  const existing = await db
    .select()
    .from(mcpToolConsents)
    .where(
      and(
        eq(mcpToolConsents.serverId, serverId),
        eq(mcpToolConsents.toolName, toolName),
      ),
    );
  if (existing.length > 0) {
    await db
      .update(mcpToolConsents)
      .set({ consent })
      .where(
        and(
          eq(mcpToolConsents.serverId, serverId),
          eq(mcpToolConsents.toolName, toolName),
        ),
      );
    return;
  }
  await db.insert(mcpToolConsents).values({ serverId, toolName, consent });
}

/**
 * C7 (security review): the interactive per-tool MCP consent gate. Before an
 * attended `mcp_call` runs a tool, this checks the stored decision and — for
 * "ask" — prompts the user (the renderer's `mcp:tool-consent-request` toast) and
 * blocks until they decide. Previously `requireConsent` was never wired on the
 * attended path, so a malicious/compromised MCP server's tool ran with no
 * confirmation (unlike run_command/edit_file).
 *
 * INDEFINITE wait (a human may take a while), cancelled only by the turn's
 * abort signal (Stop). Returns true to allow the call, false to block it.
 */
export function requestMcpToolConsent(
  sender: WebContents,
  info: {
    serverId: number;
    serverName: string;
    toolName: string;
    toolDescription?: string;
    inputPreview?: string;
  },
  abortSignal?: AbortSignal,
): Promise<boolean> {
  return (async () => {
    const stored = await getStoredConsent(info.serverId, info.toolName);
    if (stored === "always") return true;
    if (stored === "denied") return false;

    if (sender.isDestroyed()) return false;
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        pendingConsentResolvers.delete(requestId);
        if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => finish(false);
      if (abortSignal) {
        if (abortSignal.aborted) return finish(false);
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
      pendingConsentResolvers.set(requestId, (decision) => {
        void (async () => {
          if (decision === "accept-always") {
            try {
              await setStoredConsent(info.serverId, info.toolName, "always");
            } catch {
              /* persistence best-effort — still allow this call */
            }
            finish(true);
          } else if (decision === "accept-once") {
            finish(true);
          } else {
            finish(false);
          }
        })();
      });
      sender.send("mcp:tool-consent-request", { requestId, ...info });
    });
  })();
}
