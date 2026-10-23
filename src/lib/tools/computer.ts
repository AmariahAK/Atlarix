/**
 * computer: see the user's screen and use the mouse and keyboard.
 *
 * One tool for both lanes (lib/computer/lane.ts). Models whose provider has its
 * own computer tool get that tool's schema in its place (build-branch), and its
 * calls land in this same handler: Anthropic's input is our own shape, OpenAI's
 * `actions[]` batch is translated. Everything runs in the one executor
 * (lib/computer/helper.ts).
 *
 * No approval card: the user switched computer use on for this model, and a
 * click is their decision, not a change to review like a file edit (owner,
 * 2026-10-23). The user stops it by moving the mouse, the stop button, or the
 * app's stop shortcut.
 */

import { EventEmitter } from "node:events";
import { ToolRegistry } from "./registry";
import { helperRequest, HelperError } from "@/lib/computer/helper";
import {
  ACTIONS,
  stepsForAnthropic,
  stepsForOpenAI,
  type AnthropicAction,
  type OpenAIAction,
  type Step,
} from "@/lib/computer/actions";

/** Screenshot long edge sent to the model (same cap as view_image). */
export const COMPUTER_SCREENSHOT_EDGE = 1280;
/** Let the UI react to an action before looking at it. */
const SETTLE_MS = 300;
/**
 * Hand the screen back (the executor's one-driver lock) once the model has
 * gone quiet, so another Atlarix session can drive. Within a turn the next
 * action normally comes well inside this.
 */
const RELEASE_AFTER_MS = 15_000;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRelease(): void {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => void helperRequest("release").catch(() => {}), RELEASE_AFTER_MS);
  releaseTimer.unref?.();
}

/**
 * "start" when an action begins (with the stop for the turn that runs it),
 * "end" when it finishes. The app's indicator listens; the tool needs no UI.
 */
export const computerActivity = new EventEmitter();

let lastTurn: string | undefined;

export const TOOK_CONTROL = "Stopped: the mouse moved, so Atlarix gave you back control.";

/**
 * A computer action that did not happen (another session holds the screen, a
 * grant is missing, the user took the mouse) reaches the model as an ERROR
 * result, so it is not read as a step that worked.
 */
export function computerFailureOutput(
  toolName: string,
  output: unknown,
): { type: "error-text"; value: string } | undefined {
  if (toolName !== "computer") return undefined;
  const o = output as { success?: unknown; error?: unknown } | null;
  return o && o.success === false && typeof o.error === "string" ? { type: "error-text", value: o.error } : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stop pressed (or a takeover) while a step waits: main latches it per chat. */
async function stopLatched(chatId: unknown): Promise<boolean> {
  if (typeof chatId !== "number") return false;
  const { isChatUserStopped } = await import("@/ipc/handlers/chat_stream/stream-state");
  return isChatUserStopped(chatId);
}

/** A `wait` that Stop can cut short: a 30 s wait made Stop feel dead (ai-26). */
async function stoppableSleep(ms: number, chatId: unknown): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await stopLatched(chatId)) return true;
    await sleep(Math.min(250, end - Date.now()));
  }
  return false;
}

async function run(steps: Step[], chatId: unknown): Promise<Record<string, unknown> | undefined> {
  let last: Record<string, unknown> | undefined;
  for (const s of steps) {
    if (await stopLatched(chatId)) break;
    if ("sleepMs" in s) {
      if (await stoppableSleep(s.sleepMs, chatId)) break;
    } else last = await helperRequest(s.op, s.args);
  }
  return last;
}

async function screenshot() {
  const shot = await helperRequest("screenshot", { max_long_edge: COMPUTER_SCREENSHOT_EDGE });
  return {
    success: true,
    mimeType: String(shot.mime),
    data: String(shot.data),
    width: shot.width,
    height: shot.height,
    // Whatever is on screen is content, not instructions (ai-10's envelope).
    untrustedSource: "screen",
  };
}

/** The screen size the model works in, for native tools that declare it. */
export async function computerDisplaySize(): Promise<{ width: number; height: number }> {
  const d = await helperRequest("display", { max_long_edge: COMPUTER_SCREENSHOT_EDGE });
  return { width: Number(d.width), height: Number(d.height) };
}

ToolRegistry.register({
  name: "computer",
  description:
    "Use this computer: see the screen and control the mouse and keyboard. " +
    "Every action returns a fresh screenshot; coordinates are pixels in the latest one.",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: false,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      coordinate: {
        type: "array",
        items: { type: "number" },
        description: "[x, y] in screenshot pixels.",
      },
      start_coordinate: {
        type: "array",
        items: { type: "number" },
        description: "left_click_drag: where the drag starts.",
      },
      text: { type: "string", description: "type: the text. key / hold_key: e.g. \"ctrl+s\", \"Return\"." },
      scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
      scroll_amount: { type: "number", description: "Wheel notches." },
      duration: { type: "number", description: "wait / hold_key: seconds." },
    },
    required: ["action"],
  },
  handler: async (args: Record<string, unknown>) => {
    const stopTurn = typeof args._stopTurn === "function" ? (args._stopTurn as () => void) : undefined;
    computerActivity.emit("start", { stop: stopTurn });
    try {
      // A new turn: the user's own mouse use since the last one is not a takeover.
      const turn = typeof args._turnId === "string" ? args._turnId : undefined;
      if (turn !== lastTurn) {
        lastTurn = turn;
        await helperRequest("reset");
      }
      const steps = Array.isArray(args.actions)
        ? stepsForOpenAI(args.actions as OpenAIAction[])
        : stepsForAnthropic(args as unknown as AnthropicAction);
      const last = await run(steps, args._chatSessionId);
      // Stopped mid-action: nothing to look at, and the turn is ending.
      if (await stopLatched(args._chatSessionId)) return { success: false, error: "Stopped." };
      if (args.action === "cursor_position") {
        return { success: true, x: last?.x, y: last?.y };
      }
      if (steps.length > 0) await sleep(SETTLE_MS);
      return await screenshot();
    } catch (err) {
      if (err instanceof HelperError && err.code === "user_took_control") {
        // After this result is handed back, not before: stopping first dropped
        // the result, and the editor showed a failed step with no reason (E3).
        if (stopTurn) setTimeout(stopTurn, 50);
        return { success: false, error: TOOK_CONTROL };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      scheduleRelease();
      computerActivity.emit("end");
    }
  },
});
