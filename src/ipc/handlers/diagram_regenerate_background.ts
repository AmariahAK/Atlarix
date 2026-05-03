/**
 * Shared background diagram regeneration (Build/Plan/Agent chat modes).
 * Ask mode skips entirely — no auto-regen, no version rows from this path.
 */

import { db } from "@/db";
import { diagrams, apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateText } from "ai";
import { getModelClient, getEffectiveModel } from "../utils/get_model_client";
import { extractCodebase } from "../../utils/codebase";
import { getAtlarixAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import type { AppChatContext } from "../../lib/schemas";
import { generateFingerprint } from "../../lib/analysis/fingerprint";
import { persistWorkspaceSnapshotHashes } from "../../lib/snapshot/snapshot-manager";
import { invalidateBlueprintCache } from "./blueprint_handlers";
import { DIAGRAM_MERMAID_CRITICAL_RULES } from "@/lib/diagramMermaidPromptRules";
import { requireAuthSession, AuthRequiredError } from "../../lib/auth/require_auth_session";
import { normalizeDiagramAiOutput } from "../../lib/normalizeDiagramMermaid";

export type RegenerateBackgroundResult =
  | { success: true; skipped: true; reason: "ask_mode_no_auto_regen" }
  | { success: true; action: "updated" | "created"; diagramId: number }
  | { success: false; error: string };

export async function runDiagramRegenerateBackground(
  workspaceId: number,
): Promise<RegenerateBackgroundResult> {
  try {
    const settingsPre = readSettings();
    if (settingsPre.selectedChatMode === "ask") {
      return { success: true, skipped: true, reason: "ask_mode_no_auto_regen" };
    }

    try {
      await requireAuthSession();
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        return { success: false, error: "Please sign in to regenerate diagrams." };
      }
      throw e;
    }

    const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId));
    if (!app) {
      return { success: false, error: "Workspace not found" };
    }

    const appPath = getAtlarixAppPath(app.path);
    const settings = readSettings();

    const chatContext: AppChatContext = {
      contextPaths: [],
      smartContextAutoIncludes: [],
      excludePaths: [],
    };

    const { formattedOutput } = await extractCodebase({
      appPath,
      chatContext,
    });

    const modelConfig = getEffectiveModel(settings);
    const { modelClient } = await getModelClient(modelConfig, settings);

    const systemPrompt = `You are an expert software architect.
Analyze the provided codebase and generate a Mermaid.js diagram that best represents the high-level architecture.
Focus on:
- Major components/modules
- Data flow
- relationships between files
- External dependencies (if obvious)

Requirements:
- Return ONLY the mermaid code block.
- Use 'graph TB' or 'graph LR'.
- Do NOT use 'classDiagram' unless specifically appropriate for OOP analysis.
- Keep the diagram clean and readable (avoid too many nodes).
- Group related components in subgraphs.

${DIAGRAM_MERMAID_CRITICAL_RULES}

- Mermaid node IDs (left side): Use safe identifiers only (letters/numbers/underscores). If you need special characters like &, put them in the quoted label, not the node ID.
- Subgraphs: use explicit id and bracket title, e.g. subgraph clientTier [Client Tier].
- Prefer no style/classDef/class (theme-safe). If coloring nodes, the directive is lowercase style (never Style).
- Start the diagram body with graph or flowchart as the first line; do not prefix with a standalone line that is only the word mermaid (breaks detection).
- Avoid linkStyle default and long CSS on edges; prefer simple --> links when possible.`;

    const userPrompt = `Generate an architecture diagram for this project:\n\n${formattedOutput.substring(0, 50000)}`;

    const result = await generateText({
      model: modelClient.model,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    let content = normalizeDiagramAiOutput(result.text);
    const fingerprint = await generateFingerprint(appPath);

    const existingDiagram = await db.query.diagrams.findFirst({
      where: eq(diagrams.workspaceId, workspaceId),
    });

    if (existingDiagram) {
      await db
        .update(diagrams)
        .set({
          content,
          fingerprintHash: fingerprint.hash,
          fingerprintData: fingerprint,
          createdFromFileCount: fingerprint.fileCount,
          updatedAt: new Date(),
        })
        .where(eq(diagrams.id, existingDiagram.id));

      try {
        await persistWorkspaceSnapshotHashes(existingDiagram.id, appPath);
      } catch {
        /* snapshot persistence optional */
      }
      invalidateBlueprintCache(workspaceId);
      return { success: true, action: "updated", diagramId: existingDiagram.id };
    }

    const [diagram] = await db
      .insert(diagrams)
      .values({
        workspaceId,
        diagramType: "mermaid",
        title: `${app.name} Architecture`,
        content,
        metadata: { focus: "auto-generated" },
        fingerprintHash: fingerprint.hash,
        fingerprintData: fingerprint,
        createdFromFileCount: fingerprint.fileCount,
      })
      .returning();

    try {
      await persistWorkspaceSnapshotHashes(diagram.id, appPath);
    } catch {
      /* snapshot persistence optional */
    }
    invalidateBlueprintCache(workspaceId);
    return { success: true, action: "created", diagramId: diagram.id };
  } catch (error) {
    console.error("[diagram:regenerate-background] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
