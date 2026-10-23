/**
 * Which computer tool a model gets, if any (owner's design, 2026-10-23):
 *
 * - "native-anthropic" / "native-openai": the provider's own computer tool,
 *   for models LiteLLM's catalog flags and whose API speaks that provider's
 *   format;
 * - "own": our `computer` function tool, for every other model that can see
 *   images in tool results;
 * - null: switched off for this model, or it cannot see the screen.
 *
 * The switch is per model and off until the user turns it on. It is shared by
 * every surface (it lives in user-settings.json), because it is a permission
 * about this machine, not a model preference.
 */

import fs from "node:fs";
import path from "node:path";
import { readSettings, writeSettings } from "@/main/settings";
import { getUserDataPath } from "@/paths/paths";
import {
  detectVisionCapability,
  providerSupportsToolMedia,
} from "@/lib/routing/model-capability-profile";
import { isCustomAnthropicFormat } from "@/lib/routing/custom-provider-format";
import { hasNativeComputerTool } from "./catalog";
import { helperPresent } from "./helper";
import { computerUseKey } from "./eligibility";

export { computerUseKey };

export type ComputerLane = "native-anthropic" | "native-openai" | "own";

export type ComputerModel = {
  /** The provider as the settings name it (`anthropic`, `custom::x`). */
  provider?: string;
  /** The client's provider id; differs from `provider` only for Auto fallbacks. */
  builtinProviderId?: string;
  name?: string;
};

/** Why a model can't have computer use; null when it can. */
export type Ineligible = "no-vision" | "no-tool-images" | "no-executor";

export function isComputerUseOn(m: ComputerModel): boolean {
  return (readSettings().computerUseModels ?? []).includes(computerUseKey(m));
}

export function setComputerUse(m: ComputerModel, on: boolean): void {
  const key = computerUseKey(m);
  const list = (readSettings().computerUseModels ?? []).filter((k) => k !== key);
  writeSettings({ computerUseModels: on ? [...list, key] : list });
}

function providerOf(m: ComputerModel): string | undefined {
  return m.builtinProviderId ?? m.provider;
}

/**
 * The raw provider id, never mapped to "anthropic": an Anthropic-format
 * endpoint can serve a text-only model (GLM on Z.ai's), and the vision gates
 * recognise Claude behind those endpoints themselves (A1).
 */
export function computerUseIneligible(m: ComputerModel): Ineligible | null {
  if (!helperPresent()) return "no-executor";
  const provider = providerOf(m);
  if (!detectVisionCapability(provider, m.name)) return "no-vision";
  if (!providerSupportsToolMedia(provider, m.name)) return "no-tool-images";
  return null;
}

// ─── Native tools a model's API refused ─────────────────────────────────────
// A model the catalog flags can still reject the tool VERSION our SDK sends
// (Claude 5.5 on the Anthropic API takes only the newer toolset). The turn
// retries at once with our own tool and the rejection is remembered here, so it
// costs one free 400 per model per machine and never a turn.

let rejected: Set<string> | null = null;

function rejectedPath(): string {
  return path.join(getUserDataPath(), "cache", "computer-native-rejected.json");
}

function rejectedSet(): Set<string> {
  if (rejected) return rejected;
  try {
    rejected = new Set(JSON.parse(fs.readFileSync(rejectedPath(), "utf-8")) as string[]);
  } catch {
    rejected = new Set();
  }
  return rejected;
}

export function rememberNativeRejected(m: ComputerModel): void {
  const set = rejectedSet();
  set.add(computerUseKey(m));
  try {
    const file = rejectedPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...set]));
  } catch {
    // Remembered for this process at least.
  }
}

export function computerLane(m: ComputerModel): ComputerLane | null {
  if (!m.name || !isComputerUseOn(m)) return null;
  if (computerUseIneligible(m)) return null;
  if (!hasNativeComputerTool(m.name) || rejectedSet().has(computerUseKey(m))) return "own";
  const provider = providerOf(m);
  if (provider === "anthropic" || isCustomAnthropicFormat(provider)) return "native-anthropic";
  if (provider === "bedrock" && /(^|\.)anthropic\./i.test(m.name)) return "native-anthropic";
  if (provider === "openai") return "native-openai";
  // Gemini's own tool drives a browser only; everything else has no native tool.
  return "own";
}

/**
 * Said BEFORE macOS asks: its prompt names the app Atlarix runs inside (the
 * terminal for the CLI, the editor for ACP and VS Code), not Atlarix, and a
 * prompt from an app you didn't expect reads as something recording you
 * (owner, 2026-10-23). Null when nothing is left to grant, or off macOS.
 */
let bothGranted = false;
/** ACP builds its options on every session/new and model switch: never stall it on the executor. */
const NOTICE_WAIT_MS = 1500;

export async function computerUseGrantNotice(): Promise<string | null> {
  if (process.platform !== "darwin" || bothGranted) return null;
  try {
    const { helperRequest } = await import("./helper");
    const p = await Promise.race([
      helperRequest("permissions"),
      new Promise<null>((r) => setTimeout(() => r(null), NOTICE_WAIT_MS).unref?.()),
    ]);
    if (!p) return null;
    if (p.screen === "granted" && p.accessibility === "granted") {
      // Grants aren't taken back mid-session in practice: stop asking.
      bothGranted = true;
      return null;
    }
    const app = typeof p.app === "string" && p.app ? p.app : "Atlarix";
    return `macOS will ask to let ${app} record the screen and control the computer. That's Atlarix's computer use.`;
  } catch {
    return null;
  }
}

export function __resetComputerLaneForTests(): void {
  rejected = null;
  bothGranted = false;
}
