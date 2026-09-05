/**
 * runSubagent — the ONE scoped sub-agent runner behind the `task` tool.
 *
 * v13: replaces the specialist `runDelegation` (roster, presets, handoff
 * schemas). A sub-agent is a read-only scout: it gets a focused system prompt
 * (built-in `subagents/subagent` skill, or a user-defined `.atlarix/agents/`
 * agent when `subagentType` names one), a hardcoded read-only toolset, and a
 * streamed loop so the UI can show its live thinking + narration — not just
 * tool labels.
 */

import { streamText, type ModelMessage, type ToolSet } from "ai";
import log from "electron-log";
import {
  advanceCacheBreakpointsForStep,
  buildStreamMessagesWithCacheBreakpoints,
  resolveCacheMarkerPlacement,
} from "../ai/anthropic-cache-breakpoints";
import { normalizeToolInputSchemaForAiSdk } from "../ai/normalize-tool-schema";
import {
  buildContinuationPrompt,
  shouldContinue,
} from "../streaming/continuation-handler";
import { runMidLoopCompaction } from "@/lib/context/mid_loop_compaction";
import {
  resolveModelContextLimit,
  GENERIC_CONTEXT_FALLBACK,
} from "@/lib/context/resolve-model-context-limit";
import { estimateTokens } from "@/ipc/utils/token_utils";
import { recordAuxUsage } from "@/lib/usage/turn-usage-aggregator";
import { estimateModelMessagesTokens } from "@/lib/ai/native-history";
import { ToolRegistry } from "@/lib/tools/registry";
import { loadSkill } from "../skills/skill-loader";
import { runSubagentCommandViaParent } from "./subagent-command";
import { readSettings } from "../../main/settings";
import {
  getModelClient,
  getEffectiveModel,
} from "../../ipc/utils/get_model_client";
import {
  formatToolResultPreview,
  formatToolStartPreview,
} from "@/lib/chat/stream-tool-display";
import {
  formatSmallRepoInventory,
  getWorkspaceRelFilePaths,
  SMALL_REPO_FILE_THRESHOLD,
} from "@/lib/tools/workspace-file-hints";
import { loadUserAgent, renderUserAgentSystemBlock } from "./user-agents";
import { recordEditProposal } from "./subagent-proposals";

const logger = log.scope("run-subagent");

const SUBAGENT_LENGTH_CONTINUATION_MAX = 3;

/** Compact token count for the sub-agent summary badge (e.g. 12345 → "12.3k"). */
function formatCompactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Live UI events emitted while a sub-agent runs (rendered in its round card). */
export type SubagentActivityEmit =
  | {
      type: "tool_use";
      id: string;
      toolName: string;
      status: "running" | "done" | "error";
      detail?: string;
      label?: string;
      /** Raw model args — lets the nested card build a real inline diff/snippet
       * view via `buildToolExpandView` (mirrors the main chat). */
      toolArgs?: Record<string, unknown>;
      /** Serialized tool result — the expand's `rawDetail` source. */
      resultText?: string;
    }
  | { type: "subagent_progress"; preview: string }
  | {
      /** Rolling live model output. `id` is stable per segment — the renderer
       * upserts (replaces content) so the block grows in place. */
      type: "subagent_thought";
      id: string;
      channel: "reasoning" | "text";
      content: string;
    }
  | {
      /** Live cumulative token usage for this sub-agent — emitted per round so
       * the card shows a live "tok" badge instead of parsing the final summary. */
      type: "subagent_tokens";
      tokens: number;
    };

/**
 * Read-only toolset a sub-agent may use. Hardcoded — sub-agents never write,
 * never run commands, never spawn further sub-agents (depth 1 by construction).
 */
const SUBAGENT_TOOL_NAMES = [
  "read_file",
  "glob",
  "grep",
  "web_search",
  "read_url",
] as const;

/**
 * Writer sub-agents (`task({ write: true })`) additionally get the scoped FILE
 * mutation tool. Nothing they do reaches disk: `edit_file` returns a
 * `__permission_required` envelope, and with no interceptor in this path we
 * record it into the run's proposal set instead (see subagent-proposals.ts).
 * The real workspace is untouched until the MAIN agent accepts a file, which
 * lands it through the ordinary approval gate.
 *
 * `run_command` is deliberately NOT exposed here: a command writes for real,
 * and there is no proposal to review afterwards. Commands and tests run on the
 * MAIN agent, after the reviewed changes are applied.
 */
const WRITER_SUBAGENT_TOOL_NAMES = [
  ...SUBAGENT_TOOL_NAMES,
  "edit_file",
] as const;

/**
 * QA sub-agents exercise a RUNNING app, so they get the two things every other
 * worker is denied: a terminal and the browser.
 *
 * That is not a loosening of the writer rule, it is the other side of it. A
 * writer's output is a diff, so everything it does can be deferred and reviewed —
 * which is exactly why `run_command` is withheld there (a command writes for real
 * and leaves nothing to review). For QA the opposite holds: running the thing IS
 * the observation, so deferring it means the worker learns nothing, cannot
 * iterate, and stops being exploratory.
 *
 * What keeps it safe is not the toolset but the profile: no `edit_file` at all,
 * and every command forced into the READ-ONLY OS sandbox by
 * `runSubagentCommandViaParent` — workspace writes denied by the OS, while
 * caches, /tmp and the network stay available.
 *
 * `background_jobs` is here so a worker can read the dev server's log the MAIN
 * agent started; a 500 with an empty body means the trace is only there.
 */
const QA_SUBAGENT_TOOL_NAMES = [
  ...SUBAGENT_TOOL_NAMES,
  "run_command",
  "background_jobs",
  "browser",
  "browser_inspect",
  "browser_test",
  // v14.41: a QA worker verifying a mobile build needs the same read/act pair
  // it gets for the web — running the thing IS the observation.
  "mobile",
  "computer",
  "computer_inspect",
  "mobile_inspect",
] as const;

/** Tools whose nested expand detail may be larger (read/search payloads). */
const SUBAGENT_NESTED_EXPAND_TOOLS = new Set<string>([
  "read_file",
  "read_url",
  "grep",
  "glob",
]);

function subagentNestedToolDetail(toolName: string, out: string): string {
  const max = SUBAGENT_NESTED_EXPAND_TOOLS.has(toolName) ? 12_000 : 2_000;
  return out.length > max ? out.slice(0, max) : out;
}

/** Throttle for rolling thought/text emission (ms). */
const THOUGHT_EMIT_INTERVAL_MS = 400;
/** Cap per rolling segment so a chatty model can't flood the activity stream. */
const THOUGHT_SEGMENT_CHAR_CAP = 4_000;

export type RunSubagentArgs = {
  prompt: string;
  /** A user-defined `.atlarix/agents/<name>` agent; omit for the generic scout. */
  subagentType?: string;
  workspace?: string;
  /**
   * "implement" exposes the scoped write tool and records its edits into
   * `proposalSetId` rather than writing them. Default "scout" = read-only.
   * The caller owns the proposal-set lifecycle (create → run → close → review).
   */
  mode?: "scout" | "implement";
  proposalSetId?: string;
  workspaceId?: number;
  chatId?: number;
  turnId?: string;
  /** Parent tool-execute chat mode (gates nested registry execution). */
  delegationChatMode?: "build" | "plan" | "ask";
  /**
   * Window that spawned this worker. Injected into every tool call as
   * `_ownerWindowId` so a browser tool resolves THAT window's scope instead of
   * silently falling back to whichever window happens to be focused.
   */
  ownerWindowId?: number;
  /** Stable id correlating all UI events for this run. */
  delegationId?: string;
  emit?: (payload: SubagentActivityEmit) => void;
  /**
   * Abort the sub-agent's in-flight model stream. Used by the main agent to
   * HARD-cancel a background sub-agent (`task({ task_id, cancel: true })`) — the
   * stream throws, runSubagent returns a failure, and no more tokens are spent.
   */
  abortSignal?: AbortSignal;
};

export type RunSubagentResult = {
  success: boolean;
  summary?: string;
  stepsUsed?: number;
  /** Total tokens this sub-agent burned (all rounds) — for the per-agent UI badge. */
  tokensUsed?: number;
  error?: string;
};

/**
 * Rolling thought/text emitter — one growing block per SEGMENT.
 *
 * W8 (v14.8.11): segments rotate at every tool-execution boundary. The old
 * per-round stable id (`sub-thought-…-r${round}`) coalesced the entire
 * multi-step round's reasoning into ONE item whose timestamp was pinned to
 * its first emit — so the renderer's correct (ts, seq) sort necessarily
 * showed "all thoughts on top, tools below". Each reasoning span between
 * tools is now its own item with its own first-emit ts, and the existing
 * sort interleaves thought → tool → thought chronologically with zero
 * renderer changes.
 */
export function makeRollingEmitter(
  emit: ((payload: SubagentActivityEmit) => void) | undefined,
  delegationId: string,
  round: number,
) {
  let reasoningBuf = "";
  let textBuf = "";
  let lastEmit = 0;
  let segment = 0;

  const flush = (channel: "reasoning" | "text", force: boolean) => {
    if (!emit) return;
    const now = Date.now();
    if (!force && now - lastEmit < THOUGHT_EMIT_INTERVAL_MS) return;
    const buf = channel === "reasoning" ? reasoningBuf : textBuf;
    const content = buf.trim();
    if (!content) return;
    lastEmit = now;
    emit({
      type: "subagent_thought",
      id:
        channel === "reasoning"
          ? `sub-thought-${delegationId}-r${round}-s${segment}`
          : `sub-text-${delegationId}-r${round}-s${segment}`,
      channel,
      content:
        content.length > THOUGHT_SEGMENT_CHAR_CAP
          ? `…${content.slice(-THOUGHT_SEGMENT_CHAR_CAP)}`
          : content,
    });
  };

  return {
    pushReasoning(delta: string) {
      reasoningBuf += delta;
      flush("reasoning", false);
    },
    pushText(delta: string) {
      textBuf += delta;
      flush("text", false);
    },
    finish() {
      flush("reasoning", true);
      flush("text", true);
    },
    /**
     * Close the current segment (force-flush BEFORE clearing — the throttle
     * would otherwise drop a short pre-tool reasoning span) and start a new
     * one. Called at each tool-execution boundary.
     */
    rotate() {
      flush("reasoning", true);
      flush("text", true);
      reasoningBuf = "";
      textBuf = "";
      segment += 1;
    },
  };
}

export async function runSubagent(
  args: RunSubagentArgs,
): Promise<RunSubagentResult> {
  const settings = readSettings();
  const workspace = args.workspace ?? "";
  const delegationChatMode = args.delegationChatMode ?? "ask";
  const delegationId = args.delegationId?.trim() || `task-${Date.now()}`;
  const emit = args.emit;

  // Writer mode runs in build mode against the REAL workspace — it reads the
  // user's actual files, and its edits never reach disk because every one is
  // captured into the proposal set below. (This used to point at an isolated
  // git worktree, which is why writers needed a git repo and could not see
  // .gitignored files; neither limit applies now.)
  const proposalSetId = args.proposalSetId?.trim() || "";
  const isImplement = args.mode === "implement" && !!proposalSetId;
  const execWorkspace = workspace;
  const execChatMode = isImplement ? "build" : delegationChatMode;

  try {
    const effectiveModel = getEffectiveModel(settings);
    const { modelClient } = await getModelClient(effectiveModel, settings, {
      delegationRole: "subagent" as const,
      delegationDepth: 1,
    });

    // System prompt: a user-defined agent when named, else the generic scout.
    let systemPrompt = "";
    let userAgentTools: readonly string[] | null = null;
    const requestedAgent = args.subagentType?.trim();
    // Keyed on the RESOLVED agent name, so a workspace `.atlarix/agents/qa.md`
    // override is still recognised as a QA worker and still gets the QA profile.
    let isQa = false;
    if (requestedAgent && workspace.trim()) {
      const userAgent = loadUserAgent(workspace, requestedAgent);
      if (userAgent) {
        systemPrompt = renderUserAgentSystemBlock(userAgent);
        if (userAgent.tools?.length) userAgentTools = userAgent.tools;
        isQa = userAgent.name === "qa";
      }
    }
    if (!systemPrompt.trim()) {
      // Writer sub-agents get a prompt that tells them they CAN write, that they
      // their edits are recorded as proposals the main agent reviews — the
      // scout prompt (subagent.md) says "READ-ONLY".
      const genericSkill = isImplement
        ? "subagents/subagent-writer"
        : "subagents/subagent";
      systemPrompt = (
        await loadSkill(genericSkill, workspace || undefined)
      ).trim();
    }
    if (!systemPrompt.trim()) {
      return { success: false, error: "Missing sub-agent system prompt" };
    }

    // v14.8.9: a sub-agent can receive a <system-reminder>-wrapped continuation
    // on a length/unknown finish; the convention is documented only in the MAIN
    // system prompt (which sub-agents don't get), so state it here too.
    systemPrompt +=
      "\n\n`<system-reminder>` blocks are injected by the harness, not the user — out-of-band guidance, not a new request. Only untagged input is genuine.";

    // Small-repo inventory hint (cheap, prevents blind exploration).
    if (workspace.trim()) {
      try {
        const { paths, count } = await getWorkspaceRelFilePaths(workspace);
        if (count > 0 && count <= SMALL_REPO_FILE_THRESHOLD) {
          systemPrompt += `\n\n## Workspace file inventory (authoritative)\n${formatSmallRepoInventory(paths)}`;
        }
      } catch (invErr) {
        logger.debug("[Subagent] workspace inventory skipped:", invErr);
      }
    }

    // Toolset: read-only scout by default, or read+scoped-write for writer mode,
    // optionally intersected with the user agent's allowlist.
    const allowed = new Set<string>(
      isImplement
        ? WRITER_SUBAGENT_TOOL_NAMES
        : isQa
          ? QA_SUBAGENT_TOOL_NAMES
          : SUBAGENT_TOOL_NAMES,
    );
    let toolsForAgent = ToolRegistry.getAll().filter((t) =>
      allowed.has(t.name),
    );
    if (userAgentTools) {
      // NARROWING only — a workspace agent's `tools:` list can never widen past
      // the hardcoded set for its kind. A name outside that set used to be
      // silently dropped, which is how an agent could end up with no tools at all
      // and no explanation; say so instead.
      const unknown = userAgentTools.filter((n) => !allowed.has(n));
      toolsForAgent = toolsForAgent.filter((t) =>
        userAgentTools!.includes(t.name),
      );
      if (toolsForAgent.length === 0) {
        return {
          success: false,
          error:
            `The agent "${requestedAgent}" has no usable tools. ` +
            (unknown.length > 0
              ? `These are not available to this kind of sub-agent: ${unknown.join(", ")}.`
              : "Its `tools:` list did not match anything."),
        };
      }
    }

    // W8: the live rolling emitter for the CURRENT round — the tool wrapper
    // rotates its segment so reasoning before/after a tool call renders as
    // separate, correctly-ordered items.
    let currentRolling: ReturnType<typeof makeRollingEmitter> | null = null;

    const toolSet: ToolSet = {};
    for (const t of toolsForAgent) {
      toolSet[t.name] = {
        description: t.description,
        // ToolRegistry stores `parameters` as raw JSON Schema; the AI SDK
        // crashes on it without the shared normalizer.
        inputSchema: normalizeToolInputSchemaForAiSdk(t.parameters) as never,
        execute: async (toolArgs: Record<string, unknown>) => {
          currentRolling?.rotate();
          const toolActivityId = `sub-tool-${delegationId}-${t.name}-${Date.now()}`;
          const startPreview = formatToolStartPreview(t.name, toolArgs);
          emit?.({
            type: "tool_use",
            id: toolActivityId,
            toolName: t.name,
            status: "running",
            label: startPreview,
            toolArgs,
          });

          let result: unknown;
          try {
            result = await ToolRegistry.execute(t.name, {
              ...toolArgs,
              workspace: execWorkspace || undefined,
              workspaceId: args.workspaceId,
              chatMode: execChatMode,
              _chatSessionId: args.chatId,
              ...(args.ownerWindowId != null
                ? { _ownerWindowId: args.ownerWindowId }
                : {}),
              // Writer mode: read_file / edit_file consult this run's proposal
              // overlay so the sub-agent sees its own uncommitted edits. An ID,
              // not the set itself — tool args are echoed into chat:activity
              // payloads and a live Map must not leak into the renderer.
              ...(proposalSetId ? { _proposalSetId: proposalSetId } : {}),
            });
          } catch (err) {
            const errMsg = String(err).slice(0, 200);
            emit?.({
              type: "tool_use",
              id: toolActivityId,
              toolName: t.name,
              status: "error",
              detail: errMsg,
              label: startPreview,
              toolArgs,
            });
            throw err;
          }

          // Writer sub-agents: edit_file only produces a `__permission_required`
          // preview — nothing writes it (the main-chat approval interceptor that
          // normally lands writes isn't in this path). Record it as a proposal
          // instead. The proposal set is both the sub-agent's own read overlay
          // (so its next edit to this file sees this one) and the review surface
          // the main agent accepts file by file. Without this the model believes
          // it edited and nothing anywhere changed.
          // QA sub-agents: `run_command` also returns only a
          // `__permission_required` envelope, for the same reason edit_file does —
          // no interceptor lives in this path. Unlike an edit there is nothing to
          // propose: running the command IS the observation, so defer it and the
          // worker learns nothing. Route it through the interceptor of the turn
          // that spawned this worker instead, which supplies the read-only
          // sandbox, the danger gate and an approval card attributed to this
          // agent. See subagent-command.ts for why borrowing is sound.
          if (isQa && t.name === "run_command") {
            result = await runSubagentCommandViaParent({
              chatId: args.chatId,
              agentName: requestedAgent || "qa",
              workspaceId: args.workspaceId,
              workspacePath: execWorkspace,
              envelope: result,
              abortSignal: args.abortSignal,
            });
          }

          if (isImplement && t.name === "edit_file" && proposalSetId) {
            try {
              const recorded = recordEditProposal(proposalSetId, result);
              if (recorded) {
                result = {
                  success: true,
                  operation: "edit_file",
                  path: recorded.relPath,
                  type: recorded.type,
                  lines: recorded.lines,
                  message: `Recorded a proposed ${recorded.type === "update" ? "change to" : "new file"} ${recorded.relPath} (${recorded.lines} lines). The main agent reviews it — keep going, don't ask for approval.`,
                };
              }
            } catch (applyErr) {
              result = {
                success: false,
                operation: "edit_file",
                error: `Could not record the proposed edit: ${String(applyErr).slice(0, 300)}`,
              };
            }
          }

          const out =
            typeof result === "object" && result !== null
              ? JSON.stringify(result)
              : String(result);

          let toolStatus: "done" | "error" = "done";
          try {
            const parsed = JSON.parse(out) as {
              success?: boolean;
              error?: string;
            };
            if (parsed?.error || parsed?.success === false) toolStatus = "error";
          } catch {
            /* plain text result */
          }
          emit?.({
            type: "tool_use",
            id: toolActivityId,
            toolName: t.name,
            status: toolStatus,
            detail: subagentNestedToolDetail(t.name, out),
            label:
              formatToolResultPreview(t.name, out, toolStatus) ?? startPreview,
            // Carry args + full result so the nested card builds the same inline
            // diff/snippet view the main chat renders (buildToolExpandView).
            toolArgs,
            resultText: out,
          });

          return out;
        },
      };
    }

    let msgs: ModelMessage[] = [{ role: "user", content: args.prompt }];
    let lengthAttempts = 0;
    let totalSteps = 0;
    let subagentTokens = 0;
    /** True once any round's size had to be estimated — marks the footer with "~". */
    let anyRoundEstimated = false;
    let round = 0;

    let tierLimit = GENERIC_CONTEXT_FALLBACK;
    try {
      tierLimit = (await resolveModelContextLimit(effectiveModel, settings))
        .tierLimit;
    } catch (e) {
      logger.warn("[Subagent] tier-limit resolve failed; generic fallback:", e);
    }
    const systemEstimate = estimateTokens(systemPrompt);
    // v13.2: sub-agent rounds are multi-step scouts — cache markers matter
    // most here. Same provider-aware placement as the main stream.
    const cacheMarkerPlacement = resolveCacheMarkerPlacement(
      modelClient.builtinProviderId,
      effectiveModel?.name,
    );

    /** One streamed round; returns the SDK result pieces we need. */
    const runRound = async () => {
      const rolling = makeRollingEmitter(emit, delegationId, round);
      currentRolling = rolling;
      const stream = streamText({
        // Same reason as the main turn (see simple-stream-text.ts): ai@7 rejects
        // system messages inside `messages`, and this shares the very same
        // cache-breakpoint builder, so it needs the same permission.
        allowSystemInMessages: true,
        model: modelClient.model,
        abortSignal: args.abortSignal,
        messages: buildStreamMessagesWithCacheBreakpoints({
          systemHeader: systemPrompt,
          history: msgs,
          placement: cacheMarkerPlacement,
        }),
        tools: toolSet,
        stopWhen: [() => false],
        // v13.3: per-step breakpoint advancement — scouts are multi-step,
        // so the turn's growing tool tail must cache incrementally too.
        prepareStep:
          cacheMarkerPlacement !== "none"
            ? ({ messages, stepNumber }: { messages: ModelMessage[]; stepNumber: number }) =>
                stepNumber > 0
                  ? {
                      messages: advanceCacheBreakpointsForStep(
                        messages,
                        cacheMarkerPlacement,
                      ),
                    }
                  : undefined
            : undefined,
      } as Parameters<typeof streamText>[0]);

      for await (const part of stream.stream) {
        const p = part as { type: string; text?: string };
        if (p.type === "reasoning-delta" && p.text) {
          rolling.pushReasoning(p.text);
        } else if (p.type === "text-delta" && p.text) {
          rolling.pushText(p.text);
        }
      }
      rolling.finish();
      currentRolling = null;

      const [text, finishReason, usage, response, steps] = await Promise.all([
        stream.text,
        stream.finishReason,
        stream.usage,
        stream.response,
        stream.steps,
      ]);
      round += 1;
      return { text, finishReason, usage, response, steps };
    };

    /**
     * What this round cost, when the provider will not say.
     *
     * Estimated over the request messages plus the reply, using the same
     * `estimateModelMessagesTokens` the compaction path uses — one notion of an
     * estimated token count rather than a second one that drifts from it. Only
     * consulted when the provider reported no usage; see `recordAuxUsage`.
     */
    const estimateRoundTokens = (
      requestMsgs: ModelMessage[],
      text: string | undefined,
    ): number =>
      estimateModelMessagesTokens(requestMsgs) +
      estimateModelMessagesTokens([
        { role: "assistant", content: text ?? "" } as ModelMessage,
      ]);

    let result = await runRound();
    totalSteps += result.steps?.length ?? 0;
    {
      const recorded = recordAuxUsage(args.chatId, result.usage, "subagent:task", {
        estimateTokens: () => {
          anyRoundEstimated = true;
          return estimateRoundTokens(msgs, result.text);
        },
      });
      subagentTokens += recorded ?? 0;
    }
    if (subagentTokens > 0) emit?.({ type: "subagent_tokens", tokens: subagentTokens });

    while (
      shouldContinue(result.finishReason, {
        attemptCount: lengthAttempts,
        maxAttempts: SUBAGENT_LENGTH_CONTINUATION_MAX,
      })
    ) {
      lengthAttempts++;
      msgs = [
        ...msgs,
        ...(result.response.messages as ModelMessage[]),
        {
          role: "user",
          content: buildContinuationPrompt({
            chatId: args.chatId ?? 0,
            turnId: args.turnId ?? "subagent",
            attemptCount: lengthAttempts,
            maxAttempts: SUBAGENT_LENGTH_CONTINUATION_MAX,
            lastContent: result.text ?? "",
          }),
        },
      ];

      const compaction = await runMidLoopCompaction({
        messages: msgs,
        systemPromptEstimate: systemEstimate,
        tierLimit,
        chatId: args.chatId ?? 0,
        loopLabel: "Subagent",
        onInfo: (msg) => logger.log(msg),
        onWarn: (msg, err) => logger.warn(msg, err),
      });
      if (compaction.compacted) msgs = compaction.messages;

      result = await runRound();
      totalSteps += result.steps?.length ?? 0;
      {
        const recorded = recordAuxUsage(args.chatId, result.usage, "subagent:task", {
          estimateTokens: () => {
            anyRoundEstimated = true;
            return estimateRoundTokens(msgs, result.text);
          },
        });
        subagentTokens += recorded ?? 0;
      }
      if (subagentTokens > 0) emit?.({ type: "subagent_tokens", tokens: subagentTokens });
    }

    const toolNames: string[] = [];
    for (const step of result.steps ?? []) {
      const tc = (step as { toolCalls?: { toolName?: string }[] }).toolCalls;
      if (Array.isArray(tc)) {
        for (const c of tc) {
          if (c?.toolName) toolNames.push(String(c.toolName));
        }
      }
    }
    const uniqTools = [...new Set(toolNames)];
    const toolsFooter =
      uniqTools.length > 0 ? `\n\n— Tools used: ${uniqTools.join(", ")}` : "";
    // Per-sub-agent token readout, folded into the summary so it shows on the
    // sub-agent card and gives the main agent honest delegation-cost feedback.
    // "~" when any round's provider reported no usage, so a mixed measured/estimated
    // figure is never shown as if it were measured.
    const tokensFooter =
      subagentTokens > 0
        ? `\n— ${anyRoundEstimated ? "~" : ""}${formatCompactTokens(subagentTokens)} tokens`
        : "";

    logger.info(
      `Subagent run complete (id=${delegationId}); steps=${totalSteps}; tokens=${subagentTokens}`,
    );
    return {
      success: true,
      summary:
        (result.text?.trim() || "(No summary produced)") + toolsFooter + tokensFooter,
      stepsUsed: totalSteps,
      tokensUsed: subagentTokens,
    };
  } catch (err) {
    logger.error(`runSubagent failed (id=${delegationId}):`, err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
