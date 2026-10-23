/**
 * Computer actions in the shapes models send, turned into executor steps.
 *
 * Our own `computer` tool takes Anthropic's action shape on purpose: it is the
 * one models are trained on, so the own lane and the native Anthropic lane share
 * it unchanged. OpenAI's native tool sends a batch of `actions[]` instead; it is
 * translated here, once. Coordinates are screenshot pixels in every shape, and
 * the executor maps them onto the display.
 */

import type { HelperOp } from "./helper";

export type Step = { op: HelperOp; args?: Record<string, unknown> } | { sleepMs: number };

export const ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "type",
  "key",
  "hold_key",
  "scroll",
  "wait",
  "cursor_position",
] as const;

export type AnthropicAction = {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
};

const MAX_WAIT_MS = 30_000;

function xy(c: unknown, field: string): { x: number; y: number } {
  if (!Array.isArray(c) || c.length !== 2 || !c.every((n) => Number.isFinite(n))) {
    throw new Error(`${field} must be [x, y]`);
  }
  return { x: Number(c[0]), y: Number(c[1]) };
}

function optionalXy(c: unknown): { x?: number; y?: number } {
  return c == null ? {} : xy(c, "coordinate");
}

function seconds(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(Math.max(0, v * 1000), MAX_WAIT_MS);
}

function text(a: AnthropicAction): string {
  if (typeof a.text !== "string" || a.text === "") throw new Error(`${a.action} needs text`);
  return a.text;
}

export function stepsForAnthropic(a: AnthropicAction): Step[] {
  const clicks: Record<string, [string, number]> = {
    left_click: ["left", 1],
    right_click: ["right", 1],
    middle_click: ["middle", 1],
    double_click: ["left", 2],
    triple_click: ["left", 3],
  };
  const click = clicks[a.action];
  if (click) {
    if (a.text) throw new Error("holding keys during a click is not supported; press them with key first");
    return [{ op: "click", args: { ...optionalXy(a.coordinate), button: click[0], count: click[1] } }];
  }
  switch (a.action) {
    case "screenshot":
      return [];
    case "mouse_move":
      return [{ op: "move", args: xy(a.coordinate, "coordinate") }];
    case "left_click_drag": {
      const from = xy(a.start_coordinate, "start_coordinate");
      const to = xy(a.coordinate, "coordinate");
      return [{ op: "drag", args: { ...from, to_x: to.x, to_y: to.y } }];
    }
    case "left_mouse_down":
    case "left_mouse_up":
      return [
        {
          op: "button",
          args: { ...optionalXy(a.coordinate), button: "left", direction: a.action === "left_mouse_down" ? "down" : "up" },
        },
      ];
    case "type":
      return [{ op: "type", args: { text: text(a) } }];
    case "key":
      return [{ op: "key", args: { combo: text(a) } }];
    case "hold_key":
      return [{ op: "key", args: { combo: text(a), hold_ms: seconds(a.duration, 1) } }];
    case "scroll": {
      const n = Math.max(1, Math.round(a.scroll_amount ?? 3));
      const dir = a.scroll_direction ?? "down";
      const delta = { up: { dy: -n }, down: { dy: n }, left: { dx: -n }, right: { dx: n } }[dir];
      if (!delta) throw new Error(`unknown scroll_direction: ${dir}`);
      return [{ op: "scroll", args: { ...optionalXy(a.coordinate), ...delta } }];
    }
    case "wait":
      return [{ sleepMs: seconds(a.duration, 1) }];
    case "cursor_position":
      return [{ op: "cursor" }];
    default:
      throw new Error(`unknown action: ${a.action}`);
  }
}

/** OpenAI's computer tool: one batch, run in order, one screenshot after. */
export type OpenAIAction = { type: string; [k: string]: unknown };

/** OpenAI scrolls in pixels; the executor in wheel notches. */
function notches(px: unknown): number {
  const v = Number(px) || 0;
  return v === 0 ? 0 : Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / 100));
}

export function stepsForOpenAI(actions: OpenAIAction[]): Step[] {
  const out: Step[] = [];
  for (const a of actions) {
    const at = { x: Number(a.x), y: Number(a.y) };
    switch (a.type) {
      case "click": {
        const button = a.button === "wheel" ? "middle" : a.button;
        if (button !== "left" && button !== "right" && button !== "middle") {
          throw new Error(`the ${String(a.button)} mouse button is not supported`);
        }
        out.push({ op: "click", args: { ...at, button, count: 1 } });
        break;
      }
      case "double_click":
        out.push({ op: "click", args: { ...at, button: "left", count: 2 } });
        break;
      case "move":
        out.push({ op: "move", args: at });
        break;
      case "drag": {
        const p = (a.path as Array<{ x: number; y: number }>) ?? [];
        if (p.length < 2) throw new Error("drag needs a path of at least two points");
        const [first, last] = [p[0]!, p[p.length - 1]!];
        out.push({ op: "drag", args: { x: first.x, y: first.y, to_x: last.x, to_y: last.y } });
        break;
      }
      case "keypress":
        out.push({ op: "key", args: { combo: ((a.keys as string[]) ?? []).join("+") } });
        break;
      case "type":
        out.push({ op: "type", args: { text: String(a.text ?? "") } });
        break;
      case "scroll":
        out.push({ op: "scroll", args: { ...at, dx: notches(a.scrollX), dy: notches(a.scrollY) } });
        break;
      case "wait":
        out.push({ sleepMs: 1000 });
        break;
      case "screenshot":
        break;
      default:
        throw new Error(`unknown action: ${a.type}`);
    }
  }
  return out;
}
