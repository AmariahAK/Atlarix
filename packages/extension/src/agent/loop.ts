/**
 * The agent loop — rounds of model, tools, model, until the model stops asking.
 *
 * WHERE THIS RUNS, AND WHY IT IS NOT THE SERVICE WORKER OR AN OFFSCREEN
 * DOCUMENT. It runs in the side panel, and that was a correction rather than
 * the plan.
 *
 * The service worker is out for a measured reason: Chrome's own lifecycle
 * documentation states that a `fetch()` whose response takes more than 30
 * seconds kills the worker. A streamed model turn is exactly that fetch, and an
 * extension API call does not help because we are not making any while waiting
 * for the first token. The turn would die mid-sentence, on the long turns
 * rather than the short ones — the worst possible distribution.
 *
 * The offscreen document was the plan and is out for a different reason:
 * `chrome.offscreen.createDocument` takes a `reason` from a CLOSED enum —
 * AUDIO_PLAYBACK, BLOBS, CLIPBOARD, DOM_PARSER, DOM_SCRAPING, IFRAME_SCRIPTING,
 * LOCAL_STORAGE, WORKERS, and a handful of device APIs. None of them means "run
 * a long job", and every one of them would be a false statement about what this
 * document does, in a field the Web Store reads. Claiming WORKERS in order to
 * have somewhere to run a loop, and then spawning a worker so the claim is
 * technically true, is the sort of thing this codebase does not do.
 *
 * So: the side panel, which is an ordinary document with an ordinary lifetime
 * and no idle death, and which is where the user is looking anyway. THE COST IS
 * REAL and is stated where the user can see it: closing the panel ends the turn
 * in progress. It is mitigated by persisting the session after every round, so
 * reopening shows everything up to the last completed one — not by pretending
 * the turn survived.
 *
 * NO ROUND CAP, NO STEP CAP, NO WALL-CLOCK CAP. The desktop loop settled this
 * in 2026-06 after a 25-minute spin: length caps guillotine legitimate long
 * tasks, which is the thing actually worth avoiding, and they were redundant
 * because the repetition guard already fires. Termination is on STUCK-NESS.
 * The guard here is the same one, and deliberately the same shape — three
 * consecutive byte-identical rounds of tool calls.
 *
 * There are two other stops, and both belong to the user rather than to us: the
 * Stop button (an AbortSignal), and closing the agent's tab group.
 */

import {
  CoreError,
  streamTurn,
  type CoreMessage,
  type ToolCall,
} from "../core/client";
import {
  dispatchTool,
  type Approval,
  type ToolContext,
  type ToolOutcome,
} from "../tools/dispatch";
import { TOOL_SCHEMAS } from "../tools/schemas";

/**
 * How many consecutive byte-identical tool rounds mean stuck.
 *
 * Three, matching `agentic-loop-repetition.ts` on the desktop, and it is three
 * rather than two because a model legitimately repeats a call once — re-reading
 * a page it has just navigated is the same bytes and a different page.
 */
export const DOOM_LOOP_THRESHOLD = 3;

/** Everything the UI is told while a turn runs. */
export interface AgentEvents {
  /** A round is beginning. `round` is 1-based. */
  onRound?(round: number): void;
  onText?(delta: string): void;
  /** The model's thinking, on the tiers that produce any. */
  onReasoning?(delta: string): void;
  onToolCall?(call: ToolCall): void;
  onToolResult?(call: ToolCall, content: string): void;
  /**
   * Ask the user to authorise something the loop cannot.
   *
   * A `host` request MUST be answered from inside a user gesture —
   * `permissions.request()` is unreachable otherwise, and unreachable from every
   * context this loop could run in. An `action` request is a policy stop rather
   * than a platform one, but goes the same way so the panel has one card to
   * render and the loop has one path to test.
   *
   * Resolving false is a decline, which is a normal answer, not an error.
   */
  onApproval?(request: Approval): Promise<boolean>;
}

export interface TurnArgs {
  model: string;
  system: string;
  /** The conversation so far, WITHOUT the system message. Not mutated. */
  messages: CoreMessage[];
  tools: ToolContext;
  signal?: AbortSignal;
  events?: AgentEvents;
  /** Injected for tests; the real one is `streamTurn`. */
  stream?: typeof streamTurn;
  /** Injected for tests; the real one is `dispatchTool`. */
  dispatch?: typeof dispatchTool;
}

export type TurnOutcome =
  /** The model stopped asking for tools. */
  | { kind: "complete"; messages: CoreMessage[] }
  /** The user pressed Stop, or closed the group. */
  | { kind: "aborted"; messages: CoreMessage[] }
  /** The same tool calls three rounds running. */
  | { kind: "stuck"; messages: CoreMessage[] }
  /** Core refused or broke. `messages` still holds whatever completed. */
  | { kind: "error"; messages: CoreMessage[]; error: CoreError };

/**
 * What the model is told when the user says no.
 *
 * A DECLINE IS A DECISION, NOT AN OBSTACLE, and saying so is what stops the
 * model treating it as a puzzle — trying the same thing through a different
 * tool, or asking again two turns later. It is also the only honest description:
 * the user was asked and answered.
 */
function declineMessage(request: Approval): string {
  if (request.kind === "host") {
    return (
      `The user did not allow ${request.origin}, so nothing was read. This is their ` +
      `decision and not an error — do not ask again for the same site in this ` +
      `conversation. Carry on without that page, or tell them what you would have ` +
      `needed it for.`
    );
  }
  return (
    `The user declined this action, so nothing was done. It was stopped because it ` +
    `looked like it involved ${request.category.replace(/_/g, " ")}, and no site ` +
    `permission can authorise that on their behalf — only they can. Do not attempt it ` +
    `another way. Tell them what you were going to do and let them do it themselves.`
  );
}

/** The identity of a round's tool calls, for the repetition guard. */
function roundSignature(calls: ToolCall[]): string {
  // Name AND arguments, and the id deliberately excluded — the id changes every
  // round by construction, so including it would make the guard unfireable.
  return JSON.stringify(
    calls.map((c) => [c.function.name, c.function.arguments]),
  );
}

/**
 * Run one user turn to completion.
 *
 * Returns every message produced, which the caller appends to the session. On
 * an abort or an error it returns what completed rather than nothing: a turn
 * that read three pages and then hit a 402 should not lose the three pages, and
 * the model's own record of what it already did is what stops it repeating the
 * work on the next attempt.
 */
export async function runTurn(args: TurnArgs): Promise<TurnOutcome> {
  const stream = args.stream ?? streamTurn;
  const dispatch = args.dispatch ?? dispatchTool;
  const events = args.events ?? {};

  const produced: CoreMessage[] = [];
  const history: CoreMessage[] = [
    { role: "system", content: args.system },
    ...args.messages,
  ];

  let lastSignature: string | null = null;
  let repeats = 1;
  let round = 0;

  for (;;) {
    if (args.signal?.aborted) return { kind: "aborted", messages: produced };

    round += 1;
    events.onRound?.(round);

    let text = "";
    let calls: ToolCall[] = [];

    try {
      for await (const event of stream(
        {
          model: args.model,
          messages: history,
          tools: TOOL_SCHEMAS,
          signal: args.signal,
        },
        fetch,
      )) {
        if (event.type === "text") {
          text += event.delta;
          events.onText?.(event.delta);
        } else if (event.type === "reasoning") {
          // NOT accumulated into `text`, and never sent back to the provider.
          // Reasoning is a view of this turn, not part of the conversation: a
          // model handed its own previous thinking as assistant content starts
          // treating it as something it said out loud.
          events.onReasoning?.(event.delta);
        } else if (event.type === "tool-calls") {
          calls = event.calls;
        }
      }
    } catch (err) {
      // An abort arrives here as a DOMException from fetch, not as a CoreError,
      // and calling it an error would show the user a failure for something
      // they did on purpose.
      if (args.signal?.aborted) return { kind: "aborted", messages: produced };
      const error =
        err instanceof CoreError
          ? err
          : new CoreError(
              0,
              "stream_failed",
              err instanceof Error ? err.message : String(err),
            );
      return { kind: "error", messages: produced, error };
    }

    // The assistant's own message goes in BEFORE the tool results, tool_calls
    // and all. A tool result whose call is not in the history is a message the
    // provider rejects outright — and the id has to be the one the model sent,
    // which is why the client invents one when the provider omits it.
    const assistant: CoreMessage = {
      role: "assistant",
      content: text || null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    };
    history.push(assistant);
    produced.push(assistant);

    if (calls.length === 0) return { kind: "complete", messages: produced };

    // ── The repetition guard ────────────────────────────────────────────────
    const signature = roundSignature(calls);
    repeats = signature === lastSignature ? repeats + 1 : 1;
    lastSignature = signature;
    if (repeats >= DOOM_LOOP_THRESHOLD) {
      // Stop asking for tools and let it say something. A turn that ends on
      // silence looks like a crash; the model summarising what it got stuck on
      // is information the user can act on.
      const closing = await finishWithoutTools(
        args,
        history,
        stream,
        events,
        produced,
      );
      return closing ?? { kind: "stuck", messages: produced };
    }

    // ── Tools ───────────────────────────────────────────────────────────────
    // SEQUENTIAL, not parallel. Two `open_tab` calls at once race to create the
    // agent's tab group and produce two groups; and the user answering two
    // permission prompts simultaneously is not a thing the panel can show.
    for (const call of calls) {
      if (args.signal?.aborted) return { kind: "aborted", messages: produced };

      events.onToolCall?.(call);
      let outcome: ToolOutcome;
      try {
        outcome = await dispatch(call, args.tools);
      } catch (err) {
        // `dispatchTool` converts its own failures and is not supposed to reach
        // here. Defence in depth, because the consequence of being wrong is
        // severe and asymmetric: an escaped throw ends the user's whole turn
        // over one tool, discarding every message this run produced.
        if (args.signal?.aborted)
          return { kind: "aborted", messages: produced };
        outcome = {
          content:
            `${call.function.name} threw instead of returning a result: ` +
            `${err instanceof Error ? err.message : String(err)}. This is a fault ` +
            `in Atlarix — do not retry the same call.`,
        };
      }

      if (outcome.needsApproval) {
        const request = outcome.needsApproval;
        const allowed = (await events.onApproval?.(request)) ?? false;
        outcome = allowed
          ? // Exactly once. If the user said yes and the call STILL wants
            // approval, something is wrong that asking again will not fix — and
            // a second prompt for something just approved reads as the
            // extension not listening.
            await dispatch(call, args.tools)
          : { content: declineMessage(request) };
        if (outcome.needsApproval) {
          outcome = {
            content:
              `This still cannot proceed after the user approved it. Do not retry — ` +
              `tell the user what you were trying to do` +
              (request.kind === "host"
                ? `, and suggest they check Atlarix's site access in chrome://extensions.`
                : `.`),
          };
        }
      }

      const message: CoreMessage = {
        role: "tool",
        tool_call_id: call.id,
        content: outcome.content,
      };
      history.push(message);
      produced.push(message);
      events.onToolResult?.(call, outcome.content);
    }
  }
}

/**
 * One final round with no tools, so a stuck turn ends in words.
 *
 * Returns null when even this fails — at which point `stuck` with no closing
 * text is still a truthful outcome and the panel says so itself.
 */
async function finishWithoutTools(
  args: TurnArgs,
  history: CoreMessage[],
  stream: typeof streamTurn,
  events: AgentEvents,
  produced: CoreMessage[],
): Promise<TurnOutcome | null> {
  const nudge: CoreMessage = {
    role: "user",
    content:
      "You have repeated the same tool calls three times without making progress. " +
      "Stop calling tools. Tell me what you were trying to do, what you got back, " +
      "and what you would need in order to continue.",
  };
  let text = "";
  try {
    for await (const event of stream(
      {
        model: args.model,
        // No `tools` at all — the client omits the field entirely when the list
        // is empty, which is what makes this round incapable of another call
        // rather than merely discouraged from one.
        messages: [...history, nudge],
        signal: args.signal,
      },
      fetch,
    )) {
      if (event.type === "text") {
        text += event.delta;
        events.onText?.(event.delta);
      } else if (event.type === "reasoning") {
        events.onReasoning?.(event.delta);
      }
    }
  } catch {
    return null;
  }
  if (!text) return null;
  produced.push({ role: "assistant", content: text });
  return { kind: "stuck", messages: produced };
}
