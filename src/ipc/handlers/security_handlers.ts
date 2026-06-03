import { ipcMain } from "electron";
import { db } from "../../db";
import { chatSessions, sessionMessages } from "../../db/schema";
import { eq, and, or, like, desc } from "drizzle-orm";
import type { SecurityReviewResult, SecurityFinding } from "../ipc_types";

export function registerSecurityHandlers() {
  ipcMain.handle("get-latest-security-review", async (_event, appId: number) => {
    if (!appId) {
      throw new Error("App ID is required");
    }

    const result = await db
      .select({
        content: sessionMessages.content,
        createdAt: sessionMessages.createdAt,
        sessionId: sessionMessages.sessionId,
      })
      .from(sessionMessages)
      .innerJoin(chatSessions, eq(sessionMessages.sessionId, chatSessions.id))
      .where(
        and(
          eq(chatSessions.workspaceId, appId),
          eq(sessionMessages.role, "assistant"),
          or(
            like(sessionMessages.content, "%<dyad-security-finding%"),
            like(sessionMessages.content, "%<atlarix-security-finding%"),
          ),
        ),
      )
      .orderBy(desc(sessionMessages.createdAt))
      .limit(1);

    if (result.length === 0) {
      throw new Error("No security review found for this app");
    }

    const message = result[0];
    const findings = parseSecurityFindings(message.content);

    if (findings.length === 0) {
      throw new Error("No security review found for this app");
    }

    return {
      findings,
      timestamp: message.createdAt.toISOString(),
      chatId: null,
      sessionId: message.sessionId,
    } satisfies SecurityReviewResult & { sessionId: string };
  });
}

function parseSecurityFindings(content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const tagRegex =
    /<(?:dyad|atlarix)-security-finding\s+level="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/(?:dyad|atlarix)-security-finding>/g;
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    findings.push({
      level: match[1] as SecurityFinding["level"],
      title: match[2],
      description: match[3].trim(),
    });
  }
  return findings;
}
