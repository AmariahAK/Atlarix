/**
 * buildPromptBundle — assembles the turn's system prompt + context blob from the
 * loaded ContextSections, extracted from runStream's assembly phase. Pure
 * (returns a bundle; the only side effect is the chat:context-report emit).
 * Takes the turn-assembly config it reads as an explicit `deps` object.
 *
 * (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import type { ModelMessage } from "ai";
import type { IpcMainInvokeEvent } from "electron";
import type { WorkMode } from "@/lib/schemas";
import type { ChatContextReport, ChatStreamParams } from "@/ipc/ipc_types";
import {
  assembleContextSections,
  type ContextSection,
} from "@/lib/context/ContextAssembler";
import { systemReminder } from "@/lib/streaming/system-reminder";
import { SUMMARIZE_CHAT_SYSTEM_PROMPT } from "@/prompts/summarize_chat_system_prompt";
import { safeSend } from "@/ipc/utils/safe_sender";

const logger = log.scope("chat_stream_handlers");

export interface PromptBundleDeps {
  req: ChatStreamParams;
  event: IpcMainInvokeEvent;
  effectiveAppId: number | null | undefined;
  effectiveWorkMode: WorkMode;
  userPrompt: string;
  baseSystemPrompt: string;
  isSummarizeIntent: boolean;
  otherAppsCodebaseInfo: string | undefined;
  /**
   * Notes from budget pruning that happened BEFORE this rebuild
   * (describeBudgetPruning). The assembler's own trimReport is always empty —
   * its budget is unbounded — so without these the meter's "Pruned at last
   * dispatch" panel never has anything to say.
   */
  extraTrimNotes?: readonly string[];
}

export interface PromptBundle {
  systemPrompt: string;
  contextAssemblerBlob: string;
  assembledContext: ReturnType<typeof assembleContextSections>;
  hasInjectedArchitectureContext: boolean;
  codebasePrefix: readonly ModelMessage[];
  otherCodebasePrefix: readonly ModelMessage[];
}

export async function buildPromptBundle(
  sections: ContextSection[],
  deps: PromptBundleDeps,
): Promise<PromptBundle> {
  const {
    req,
    event,
    effectiveAppId,
    effectiveWorkMode,
    userPrompt,
    baseSystemPrompt,
    isSummarizeIntent,
    otherAppsCodebaseInfo,
    extraTrimNotes,
  } = deps;

  const assembledContext = assembleContextSections({
    chatId: req.chatId,
    appId: effectiveAppId ?? null,
    workMode: effectiveWorkMode,
    userPrompt: userPrompt || req.prompt,
    sections,
  });
  let systemPrompt = baseSystemPrompt;
  if (assembledContext.activeSkillAddition?.trim()) {
    systemPrompt = `${assembledContext.activeSkillAddition.trim()}\n\n${systemPrompt}`;
  }
  let blob = "";
  if (assembledContext.finalSystemPromptAddition.trim()) {
    blob = assembledContext.finalSystemPromptAddition;
    systemPrompt += `\n\n${blob}`;
  }
  logger.info(
    `[ContextAssembler] mode=${effectiveWorkMode} cacheHit=${assembledContext.cache.hit} sections=${assembledContext.assembledPromptSections.filter((s) => s.included).length}/${assembledContext.assembledPromptSections.length}`,
  );
  const trimReport = [
    ...(extraTrimNotes ?? []),
    ...assembledContext.trimReport,
  ];
  if (trimReport.length > 0) {
    logger.info(`[ContextAssembler] trims: ${trimReport.join(" | ")}`);
  }
  // v10 context meter: surface per-section sizes + trims to the renderer.
  safeSend(event.sender, "chat:context-report", {
    chatId: req.chatId,
    sections: assembledContext.assembledPromptSections.map((s) => ({
      name: s.name,
      tokens: s.tokens,
      included: s.included,
      truncated: s.truncated,
    })),
    trimReport,
  } satisfies ChatContextReport);
  const hasInjectedArchitectureContext =
    assembledContext.assembledPromptSections.some(
      (s) => s.included && s.name === "workspaceAnalysis",
    );
  // The @-mention context block (file contents / folder listings) is
  // injected as a prefix message below, not into the cached system prompt.

  // PASS5: Supabase context is injected by the Supabase tool handler
  // when the model actually calls a Supabase tool (v11.1: dead
  // per-turn pre-injection block deleted).
  if (isSummarizeIntent) {
    systemPrompt = SUMMARIZE_CHAT_SYSTEM_PROMPT;
  }

  const hasImageAttachments =
    req.attachments &&
    req.attachments.some((attachment) => attachment.type.startsWith("image/"));

  const hasUploadedAttachments =
    req.attachments &&
    req.attachments.some(
      (attachment) => attachment.attachmentType === "upload-to-codebase",
    );
  if (hasUploadedAttachments) {
    systemPrompt += `

When files are attached to this conversation, upload them to the codebase using this exact format:

<atlarix-write path="path/to/destination/filename.ext" description="Upload file to codebase">
ATLARIX_ATTACHMENT_X
</atlarix-write>

Example for file with id of ATLARIX_ATTACHMENT_0:
<atlarix-write path="src/components/Button.jsx" description="Upload file to codebase">
ATLARIX_ATTACHMENT_0
</atlarix-write>

  `;
  } else if (hasImageAttachments) {
    systemPrompt += `

# Image Analysis Instructions
This conversation includes one or more image attachments. When the user uploads images:
1. If the user explicitly asks for analysis, description, or information about the image, please analyze the image content.
2. Describe what you see in the image if asked.
3. You can use images as references when the user has coding or design-related questions.
4. For diagrams or wireframes, try to understand the content and structure shown.
5. For screenshots of code or errors, try to identify the issue or explain the code.
`;
  }

  // PASS5: diagram-first prefix removed — the model calls diagram
  // tools when needed (v11.1: dead synthetic-turn block deleted).
  const codebasePrefix: readonly ModelMessage[] = []; // PASS5: always empty now

  const otherCodebasePrefix = otherAppsCodebaseInfo
    ? ([
        {
          role: "user",
          // v14.8.8: harness-supplied context, not a user turn.
          content: systemReminder(otherAppsCodebaseInfo),
        },
        {
          role: "assistant",
          content: "OK.",
        },
      ] as const)
    : [];

  return {
    systemPrompt,
    contextAssemblerBlob: blob,
    assembledContext,
    hasInjectedArchitectureContext,
    codebasePrefix,
    otherCodebasePrefix,
  };
}
