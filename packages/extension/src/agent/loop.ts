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
import type { MadeFile } from "../files/store";
import { messageText } from "../context/budget";

/**
 * Characters of the tool schemas, which the provider counts as part of every
 * request. Computed once: the list does not change within a build.
 */
const TOOL_SCHEMA_CHARS = JSON.stringify(TOOL_SCHEMAS).length;

/** One message's text, for measuring what was actually sent. */
const messageChars = (m: CoreMessage): number => messageText(m).length;

/**
 * How many consecutive byte-identical tool rounds mean stuck.
 *
 * Three, matching `agentic-loop-repetition.ts` on the desktop, and it is three
 * rather than two because a model legitimately repeats a call once — re-reading
 * a page it has just navigated is the same bytes and a different page.
 */
export const DOOM_LOOP_THRESHOLD = 3;

/**
 * How many times one round may be re-asked after a RETRYABLE failure.
 *
 * Two, and the ceiling matters more than the number: a request that has failed
 * three times is not having a bad moment, and a loop that keeps asking turns one
 * outage into a bill. Non-retryable errors — 402, 403, a refused model — never
 * reach this at all.
 */
export const MAX_STREAM_RETRIES = 2;

/** Short, then longer. A blip clears in under a second; an outage does not. */
const RETRY_BACKOFF_MS = [500, 1500];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Everything the UI is told while a turn runs. */
export interface AgentEvents {
  /** A round is beginning. `round` is 1-based. */
  onRound?(round: number): void;
  onText?(delta: string): void;
  /** The model's thinking, on the tiers that produce any. */
  onReasoning?(delta: string): void;
  /**
   * A retryable failure killed the round; everything streamed so far is void.
   *
   * The panel MUST discard the partial text and thinking it has rendered — a
   * dead stream cannot be resumed, so the retry starts from nothing and its
   * output would otherwise be appended to the corpse of the first attempt.
   */
  onRoundRestart?(attempt: number, reason: string): void;
  /**
   * The provider's own token count for the request just sent.
   *
   * EXACT, and the only exact number in this system. Fires once per round, from
   * the stream's final frame. The panel uses it to anchor its context
   * measurement and to calibrate its estimator — see `context/calibration.ts`.
   */
  onUsage?(usage: {
    promptTokens: number;
    completionTokens: number;
    /**
     * How many non-system messages were in the request this counts.
     *
     * Reported because the panel needs to know WHICH transcript the number
     * describes. Counting later would include this round's own output, and the
     * anchor would claim to have measured messages the provider never saw.
     */
    messageCount: number;
    /** Characters of the request as sent — the other half of a calibration. */
    charsSent: number;
  }): void;
  onToolCall?(call: ToolCall): void;
  /** `label` is the human phrase for the transcript, known only after the call. */
  onToolResult?(
    call: ToolCall,
    content: string,
    label?: string,
    /** Set when the call produced a relic, so the panel can offer to open it. */
    relic?: { id: string; title: string },
    /**
     * Files the call produced, so the panel can offer them as downloads.
     *
     * The bytes are NOT here and never travel through the loop — the panel
     * reads them out of `files/store.ts` when the user clicks. What crosses is
     * a name, a type and a size, which is all a card needs.
     */
    files?: MadeFile[],
  ): void;
  /**
   * Ask the user to authorise something the loop cannot.
   *
   * BOTH kinds are policy stops now. A `host` request once had to be answered
   * from inside a user gesture, because `permissions.request()` was unreachable
   * otherwise; host access is held at install, so allowing a site is a record
   * the panel writes. They go the same way regardless, which is what gives the
   * panel one card to render and the loop one path to test.
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
  /**
   * The model asked the user something and stopped. Their answer arrives as the
   * next ordinary user message, which starts a fresh turn.
   *
   * A SEPARATE KIND FROM `aborted` ON PURPOSE. Both end a turn early, but they
   * mean opposite things to the person watching: `aborted` renders "Stopped",
   * which under a question would read as the panel having failed to ask it.
   */
  | { kind: "asked"; messages: CoreMessage[] }
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
  if (request.category === "connector") {
    return (
      `The user did not approve that connector call, so nothing was sent to it. This ` +
      `is their decision — do not make the call another way. Carry on without it, or ` +
      `ask them what they would rather do.`
    );
  }
  if (request.category === "message") {
    return (
      `The user did not approve sending that message, so nothing was sent. This is ` +
      `their decision — do not send it another way. Carry on here, or ask them what ` +
      `they would rather do.`
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
    let reasoning = "";
    let attempt = 0;

    // ── One round, with retries ───────────────────────────────────────────────
    //
    // RETRYING AT THE ROUND, not inside the stream. A stream that died halfway
    // has already emitted text to the UI and into `text`; there is no way to
    // resume it, so the only honest move is to throw the partial away and ask
    // again. `onRoundRestart` is what tells the panel to do the same — without
    // it the retry's answer is appended to the corpse of the first one and the
    // user reads the same sentence twice.
    for (;;) {
      text = "";
      calls = [];
      reasoning = "";
      // Measured from the ACTUAL request, not reconstructed afterwards. The
      // tool schemas are part of what the provider counted, and leaving them out
      // would teach the calibration that the model is more expensive per
      // character than it is.
      const sentMessageCount = history.length;
      const sentChars =
        history.reduce((n, m) => n + messageChars(m), 0) + TOOL_SCHEMA_CHARS;
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
            //
            // KEPT ON THE MESSAGE ANYWAY, as of 2026-09-17. It used to exist
            // only as a local in the panel and was dropped the moment the
            // answer began, so a user reporting "it said it could not see the
            // page" had no evidence and neither did we. `client.ts`
            // `stripForWire` removes it before the request, so "never sent"
            // still holds.
            reasoning += event.delta;
            events.onReasoning?.(event.delta);
          } else if (event.type === "tool-calls") {
            calls = event.calls;
          } else if (event.type === "usage") {
            events.onUsage?.({
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              // Minus the system message, which the panel does not hold.
              messageCount: sentMessageCount - 1,
              charsSent: sentChars,
            });
          }
        }
        break;
      } catch (err) {
        // An abort arrives here as a DOMException from fetch, not as a CoreError,
        // and calling it an error would show the user a failure for something
        // they did on purpose.
        if (args.signal?.aborted)
          return { kind: "aborted", messages: produced };
        const error =
          err instanceof CoreError
            ? err
            : new CoreError(
                0,
                "stream_failed",
                err instanceof Error ? err.message : String(err),
              );

        if (!error.retryable || attempt >= MAX_STREAM_RETRIES) {
          return { kind: "error", messages: produced, error };
        }

        attempt += 1;
        // SAID OUT LOUD, not hidden. A silent retry that then fails reads as one
        // long unexplained failure, and a silent retry that succeeds hides that
        // the connection is flaky — which is something the user may want to know.
        events.onRoundRestart?.(attempt, error.message);
        await delay(RETRY_BACKOFF_MS[attempt - 1] ?? 2000);
        if (args.signal?.aborted)
          return { kind: "aborted", messages: produced };
      }
    }

    // The assistant's own message goes in BEFORE the tool results, tool_calls
    // and all. A tool result whose call is not in the history is a message the
    // provider rejects outright — and the id has to be the one the model sent,
    // which is why the client invents one when the provider omits it.
    const assistant: CoreMessage = {
      role: "assistant",
      content: text || null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
      ...(reasoning ? { reasoning } : {}),
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
    // Set by `ask_user`. The loop does NOT break on it — see below.
    let asked = false;

    // WHAT THE AGENT HAS READ THIS TURN, so `remember` can refuse a note that
    // repeats it word for word. The loop is the only thing that sees a whole
    // turn, which is why the list is built here rather than in the tool.
    const turnResults: string[] = [];

    for (const call of calls) {
      if (args.signal?.aborted) return { kind: "aborted", messages: produced };

      events.onToolCall?.(call);
      let outcome: ToolOutcome;
      try {
        outcome = await dispatch(call, { ...args.tools, recentToolResults: turnResults });
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
            await dispatch(call, {
              ...args.tools,
              recentToolResults: turnResults,
              approvedRetry: true,
            })
          : { content: declineMessage(request) };
        if (outcome.needsApproval) {
          outcome = {
            content:
              `This still cannot proceed after the user approved it. Do not retry — ` +
              `tell the user what you were trying to do` +
              (request.kind === "host"
                ? `, and suggest they check Chrome's own Site access setting for Atlarix at chrome://extensions, which can withhold a site the allow-list already covers.`
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
      // A picture from `screenshot`: shown to the model as a user image part
      // for the REST OF THIS TURN only. It goes into `history` (what is sent)
      // and not `produced` (what is saved), so a transcript never carries
      // megabytes of base64 into chrome.storage — the tool message above
      // records that a screenshot was taken.
      if (outcome.image) {
        history.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "The screenshot from that tool call:",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${outcome.image.mimeType};base64,${outcome.image.data}`,
              },
            },
          ],
        });
      }
      events.onToolResult?.(
        call,
        outcome.content,
        outcome.label,
        outcome.relic,
        outcome.files,
      );
      // AFTER the result is recorded, so `remember`'s own outcome is never in
      // the list it is checked against — a note whose text the tool echoed back
      // would otherwise look copied from itself.
      turnResults.push(outcome.content);
      if (outcome.endsTurn) asked = true;
    }

    // AFTER the batch, never inside it. Returning the moment `ask_user` lands
    // would leave the assistant message holding `tool_calls` with no matching
    // `role:"tool"` result for whatever followed it — and a history where a
    // tool_call has no result is rejected by the provider on the NEXT request,
    // which is to say when the user answers. The turn would break at the one
    // moment the feature exists to make work.
    //
    // The model is told to batch its questions into one call and not to pair
    // `ask_user` with other tools, so in practice there is nothing after it.
    // This is about what happens when it does it anyway.
    if (asked) return { kind: "asked", messages: produced };
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
  let reasoning = "";
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
        reasoning += event.delta;
        events.onReasoning?.(event.delta);
      }
    }
  } catch {
    return null;
  }
  if (!text) return null;
  produced.push({
    role: "assistant",
    content: text,
    ...(reasoning ? { reasoning } : {}),
  });
  return { kind: "stuck", messages: produced };
}
