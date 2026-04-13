import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { generateText, jsonSchema as aiJsonSchema, zodSchema, type ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import * as Sentry from "@sentry/electron/main";
import { db } from "@/db";
import { counselSessions } from "@/db/schema";
import type { UserSettings, LargeLanguageModel } from "@/lib/schemas";
import {
  getModelClient,
  getFastModelForCurrentProvider,
  getBalancedModelForCurrentProvider,
  getThinkingModelForCurrentProvider,
} from "@/ipc/utils/get_model_client";
import { safeSend } from "@/ipc/utils/safe_sender";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";
import { ToolRegistry } from "@/lib/tools";
import { loadSkill } from "@/lib/skills/skill-loader";
import { getSkillNameForMode } from "@/lib/skills/skill-registry";
import type { CounselMode, CounselParticipantRole, CounselSession } from "./counsel-session";
import type { CounselTrigger } from "./counsel-session";
import { captureSafe } from "@/main/lib/analytics";

const COUNSEL_COMPLETE_SIGNAL = "[COUNSEL_COMPLETE]";

const BASE_SYSTEM = `
You are one of three AI perspectives in a Counsel session. Your role is: {role}.

Think through the problem independently and thoroughly. Be specific. Be honest
about uncertainty. Disagree with the obvious answer if your reasoning supports
a different view.

Share your reasoning openly — the synthesising model will read all three
perspectives.

When you have fully explored the problem and reached your conclusion, end your
response with exactly:
${COUNSEL_COMPLETE_SIGNAL}

Do not end early. Do not pad.
End only when you have nothing more valuable to add.
`.trim();

const COUNSEL_TOOLS_ADDENDUM = `
You may call read-only tools to inspect the workspace or the web when the question requires
concrete evidence (files, symbols, docs). Use tools sparingly; fold findings into your reasoning.
Your final message must still end with the completion signal from the instructions above.
`.trim();

const PERMISSIVE_TOOL_JSON_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

function normalizeToolInputSchemaForCounsel(schema: unknown) {
  if (!schema || typeof schema !== "object") {
    return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
  }
  const obj = schema as Record<string, unknown>;
  if ("_def" in obj) {
    try {
      return zodSchema(obj as unknown as Parameters<typeof zodSchema>[0], { useReferences: true });
    } catch {
      return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
    }
  }
  if ("type" in obj || "$schema" in obj) {
    return aiJsonSchema(obj as JSONSchema7);
  }
  if ("jsonSchema" in obj && obj.jsonSchema && typeof obj.jsonSchema === "object") {
    return aiJsonSchema(obj.jsonSchema as JSONSchema7);
  }
  return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
}

const COUNSEL_TOOLS_WITH_WORKSPACE = [
  "read_file",
  "explore_folder",
  "list_files",
  "search_code",
  "find_file",
  "web_search",
  "deep_search",
  "read_url",
] as const;

const COUNSEL_TOOLS_GENERAL = ["web_search", "deep_search", "read_url"] as const;

function buildCounselParticipantTools(opts: {
  chatId: number;
  workspacePath?: string | null;
  workspaceId?: number | null;
  toolActivity?: { webContents: WebContents; chatId: number };
}): ToolSet {
  const hasWorkspace =
    typeof opts.workspacePath === "string" &&
    opts.workspacePath.length > 0 &&
    typeof opts.workspaceId === "number";
  const names = hasWorkspace ? COUNSEL_TOOLS_WITH_WORKSPACE : COUNSEL_TOOLS_GENERAL;
  const tools: ToolSet = {};
  for (const name of names) {
    const meta = ToolRegistry.get(name);
    if (!meta) continue;
    tools[name] = {
      description: meta.description,
      inputSchema: normalizeToolInputSchemaForCounsel(
        meta.parameters ?? (meta as { function?: { parameters?: unknown } }).function?.parameters,
      ) as never,
      execute: async (args: Record<string, unknown>) => {
        const act = opts.toolActivity;
        if (act) {
          safeSend(act.webContents, "chat:tool:start", {
            chatId: act.chatId,
            toolName: getToolActivityLabel(name),
          });
        }
        try {
          const execArgs: Record<string, unknown> = {
            ...args,
            _chatSessionId: opts.chatId,
            chatMode: "ask",
          };
          if (hasWorkspace) {
            execArgs.workspace = opts.workspacePath;
            execArgs.workspaceId = opts.workspaceId;
          }
          const result = await ToolRegistry.execute(name, execArgs);
          return typeof result === "string" ? result : JSON.stringify(result);
        } finally {
          if (act) {
            safeSend(act.webContents, "chat:tool:end", { chatId: act.chatId });
          }
        }
      },
    };
  }
  return tools;
}

async function buildCounselSkillAddendum(
  settings: UserSettings,
  workspacePath?: string | null,
): Promise<string> {
  try {
    const modeKey =
      settings.selectedChatMode === "agent" ? "build" : (settings.selectedChatMode ?? "ask");
    const modeSkillName = getSkillNameForMode(modeKey);
    const body = await loadSkill(modeSkillName, workspacePath ?? undefined);
    const trimmed = body.trim();
    if (!trimmed) return "";
    const cap = trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n…` : trimmed;
    return `[Active skill: ${modeSkillName}]\n${cap}`;
  } catch {
    return "";
  }
}

export type CounselActivityPayload = Record<string, unknown> & {
  id: string;
  type: string;
  chatId: number;
  timestamp: number;
};

function sameModel(a: LargeLanguageModel, b: LargeLanguageModel): boolean {
  return a.provider === b.provider && a.name === b.name;
}

function counselCompleteDetail(synthesis: string): string {
  const t = synthesis
    .replace(/[#*_`[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "No blockers identified.";
  const end = t.search(/[.!?]\s/);
  const first = end >= 0 ? t.slice(0, end + 1) : t;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

function buildCounselQuestion(session: CounselSession): string {
  if (session.mode === "workspace") {
    return [
      "What is the best approach for:",
      session.question,
      "",
      "Focus on: architecture decisions, potential pitfalls, key considerations.",
      "Do NOT write implementation code.",
    ].join("\n");
  }
  return session.question;
}

async function synthesiseCounsel(
  question: string,
  responses: Record<CounselParticipantRole, string | null>,
  synthesisModel: LargeLanguageModel,
  settings: UserSettings,
  degradationNote: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const formatResponse = (role: string, resp: string | null) =>
    resp ? `## ${role} perspective\n${resp}` : `## ${role} perspective\nUnavailable`;

  const prompt = [
    "You are synthesising a Counsel session.",
    degradationNote ? `\nNote: ${degradationNote}\n` : "",
    `Original question: ${question}`,
    "",
    formatResponse("Fast", responses.fast),
    "",
    formatResponse("Balanced", responses.balanced),
    "",
    formatResponse("Thinking", responses.thinking),
    "",
    "Your task:",
    "1. Where perspectives agreed — high confidence",
    "2. Where they disagreed — reason through which view is stronger and why",
    "3. Produce ONE coherent answer",
    "4. Be better than any individual perspective",
    "5. Do not just concatenate — synthesise",
  ].join("\n");

  const { modelClient } = await getModelClient(synthesisModel, settings, {
    agentMode: settings.agentMode ?? "guided",
    delegationRole: "main",
  });

  const result = await generateText({
    model: modelClient.model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2000,
    abortSignal,
  } as Parameters<typeof generateText>[0]);

  return result.text ?? "";
}

export interface RunCounselPipelineArgs {
  chatId: number;
  turnId: string;
  trigger: CounselTrigger;
  mode: CounselMode;
  question: string;
  settings: UserSettings;
  sendActivity: (payload: CounselActivityPayload) => void;
  /**
   * Counsel-owned cancellation only (e.g. `counsel:cancel`). Forwards into an internal
   * `AbortController` passed to the SDK — never pass the main chat stream's signal here.
   */
  abortSignal?: AbortSignal;
  /** Open project root — enables codebase read tools for participants. */
  workspacePath?: string | null;
  workspaceId?: number | null;
  /** When set, mirrors tool start/end to the chat UI (same as Ask mode). */
  toolActivity?: { webContents: WebContents; chatId: number };
}

/**
 * Runs counsel participants + synthesis; returns a block to inject into the main system prompt.
 */
export async function runCounselPipeline(args: RunCounselPipelineArgs): Promise<string> {
  const {
    chatId,
    turnId,
    trigger,
    mode,
    question,
    settings,
    sendActivity,
    abortSignal,
    workspacePath,
    workspaceId,
    toolActivity,
  } = args;
  const pipelineStarted = Date.now();

  try {
    if (abortSignal?.aborted) {
      return "";
    }
    const pipelineAbort = new AbortController();
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => pipelineAbort.abort(), { once: true });
    }
    const pipelineSignal = pipelineAbort.signal;

  /** Ephemeral workspace / floating chats — run counsel but skip DB persistence only. */
  const isEphemeral = chatId < 0;
  const counselCfg = settings.counsel;
  const timeoutMs = Math.min(120_000, Math.max(5_000, (counselCfg?.timeoutSeconds ?? 30) * 1000));

  const sessionId = randomUUID();
  const now = Date.now();

  const eff = settings.selectedModel;
  let fastModel = getFastModelForCurrentProvider(settings);
  let balancedModel = getBalancedModelForCurrentProvider(settings);
  let thinkingModel = getThinkingModelForCurrentProvider(settings);

  if (!fastModel) fastModel = eff;
  if (!balancedModel) balancedModel = fastModel;
  if (!thinkingModel) thinkingModel = balancedModel;
  if (!fastModel?.provider || !fastModel?.name) return "";

  let degradationNote = "";
  if (balancedModel && fastModel && sameModel(balancedModel, fastModel)) {
    degradationNote =
      "Two Fast-tier perspectives were used with different sampling (Balanced slot unavailable).";
  }
  if (thinkingModel && balancedModel && sameModel(thinkingModel, balancedModel)) {
    degradationNote = degradationNote
      ? `${degradationNote} Thinking slot reuses Balanced.`
      : "Thinking perspective reuses Balanced model.";
  }

  const session: CounselSession = {
    sessionId,
    turnId,
    chatId,
    trigger,
    mode,
    question,
    participants: [
      {
        role: "fast",
        modelId: `${fastModel.provider}:${fastModel.name}`,
        signaled: false,
        startedAt: now,
      },
      {
        role: "balanced",
        modelId: `${balancedModel.provider}:${balancedModel.name}`,
        signaled: false,
        startedAt: now,
      },
      {
        role: "thinking",
        modelId: `${thinkingModel.provider}:${thinkingModel.name}`,
        signaled: false,
        startedAt: now,
      },
    ],
    status: "running",
    createdAt: now,
  };

  sendActivity({
    id: `counsel-start-${sessionId}`,
    type: "counsel_start",
    label: "Counsel session",
    status: "running",
    timestamp: Date.now(),
    chatId,
    sessionId,
    participantCount: 3,
  });

  const skillAddendum = await buildCounselSkillAddendum(settings, workspacePath ?? null);
  const participantTools = buildCounselParticipantTools({
    chatId,
    workspacePath,
    workspaceId,
    toolActivity,
  });
  const hasParticipantTools = Object.keys(participantTools).length > 0;

  const makeParticipantPrompt = (role: CounselParticipantRole) =>
    [BASE_SYSTEM.replace("{role}", role), COUNSEL_TOOLS_ADDENDUM, skillAddendum]
      .filter((s) => s.trim().length > 0)
      .join("\n\n");

  const userContent = buildCounselQuestion(session);

  const runParticipant = async (
    role: CounselParticipantRole,
    model: LargeLanguageModel,
    temperature: number,
  ): Promise<string | null> => {
    try {
      const { modelClient } = await getModelClient(model, settings, {
        agentMode: settings.agentMode ?? "guided",
        delegationRole: "main",
      });
      const result = await Promise.race([
        generateText({
          model: modelClient.model,
          system: makeParticipantPrompt(role),
          messages: [{ role: "user", content: userContent }],
          maxTokens: 2000,
          temperature,
          abortSignal: pipelineSignal,
          ...(hasParticipantTools
            ? {
                tools: participantTools,
                stopWhen: [() => false],
              }
            : {}),
        } as Parameters<typeof generateText>[0]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("participant_timeout")), timeoutMs),
        ),
      ]);
      const text = (result as { text?: string }).text ?? "";
      return text.replace(COUNSEL_COMPLETE_SIGNAL, "").trim();
    } catch {
      return null;
    }
  };

  const fastTemp = 0.25;
  const balancedTemp =
    balancedModel && fastModel && sameModel(balancedModel, fastModel) ? 0.85 : 0.35;
  const thinkingTemp = 0.45;

  const [fastResp, balancedResp, thinkingResp] = await Promise.all([
    runParticipant("fast", fastModel, fastTemp),
    runParticipant("balanced", balancedModel, balancedTemp),
    runParticipant("thinking", thinkingModel, thinkingTemp),
  ]);

  const showPrev = counselCfg?.showParticipantPreviews !== false;
  const preview = (s: string | null) => {
    if (!showPrev || !s) return undefined;
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length <= 72) return t;
    return `${t.slice(0, 69)}…`;
  };

  const prevFast = preview(fastResp);
  const prevBalanced = preview(balancedResp);
  const prevThinking = preview(thinkingResp);

  sendActivity({
    id: `counsel-p-fast-${sessionId}`,
    type: "counsel_participant_complete",
    label: "Fast",
    status: "done",
    timestamp: Date.now(),
    chatId,
    sessionId,
    counselRole: "fast",
    preview: prevFast,
  });
  sendActivity({
    id: `counsel-p-balanced-${sessionId}`,
    type: "counsel_participant_complete",
    label: "Balanced",
    status: "done",
    timestamp: Date.now(),
    chatId,
    sessionId,
    counselRole: "balanced",
    preview: prevBalanced,
  });
  sendActivity({
    id: `counsel-p-thinking-${sessionId}`,
    type: "counsel_participant_complete",
    label: "Thinking",
    status: "done",
    timestamp: Date.now(),
    chatId,
    sessionId,
    counselRole: "thinking",
    preview: prevThinking,
  });

  sendActivity({
    id: `counsel-synth-${sessionId}`,
    type: "counsel_synthesising",
    label: "Synthesising perspectives",
    status: "running",
    timestamp: Date.now(),
    chatId,
    sessionId,
    counselRole: "synthesis",
  });

  session.status = "synthesising";
  const responses = {
    fast: fastResp,
    balanced: balancedResp,
    thinking: thinkingResp,
  };

  let synthesis = "";
  try {
    synthesis = await synthesiseCounsel(
      question,
      responses,
      balancedModel,
      settings,
      degradationNote,
      pipelineSignal,
    );
  } catch {
    synthesis =
      fastResp ||
      balancedResp ||
      thinkingResp ||
      "(Counsel synthesis failed; use individual perspectives if present.)";
  }

  session.synthesis = synthesis;
  session.status = "complete";
  session.completedAt = Date.now();

  sendActivity({
    id: `counsel-done-${sessionId}`,
    type: "counsel_complete",
    label: "Counsel complete",
    status: "done",
    timestamp: Date.now(),
    chatId,
    sessionId,
    synthesisLength: synthesis.length,
    detail: counselCompleteDetail(synthesis),
  });

  captureSafe("counsel_completed", {
    trigger_type: trigger,
    synthesis_length: synthesis.length,
    duration_ms: Date.now() - pipelineStarted,
  });

  if (!isEphemeral && chatId > 0) {
    try {
      await db.insert(counselSessions).values({
        sessionId,
        chatId,
        turnId,
        trigger,
        mode,
        question,
        fastResponse: fastResp ?? null,
        balancedResponse: balancedResp ?? null,
        thinkingResponse: thinkingResp ?? null,
        synthesis,
        status: "complete",
        createdAt: now,
        completedAt: session.completedAt,
      });
    } catch (e) {
      console.warn("[counsel] Failed to persist session:", e);
    }
  }

  return [
    "## Counsel (multi-perspective pre-analysis)",
    "The following was produced by parallel Fast, Balanced, and Thinking perspectives, then synthesised (Balanced model).",
    "Use it as grounding; the user message is the source of truth for what they want.",
    "",
    synthesis,
  ].join("\n");
  } catch (err) {
    try {
      Sentry.captureException(err, { tags: { feature: "counsel" } });
    } catch {
      /* noop */
    }
    return "";
  }
}
