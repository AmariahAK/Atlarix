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
import { anthropic } from "@ai-sdk/anthropic";
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

// ─── Native tool versions a model's API refused ─────────────────────────────
// A model the catalog flags can still reject the tool VERSION our SDK sends
// (Claude Haiku 4.5 on Bedrock takes computer_20250124, not computer_20251124;
// Claude 5.5 on the Anthropic API takes only the newer toolset). The refusal
// names what the model does take, so the next request sends that, and the
// choice is remembered (this process, and the cache on disk): one refused
// request per model per machine, never one per request (15.11.0, Bedrock).

/** Per model: the native versions it refused, and any version its refusal named. */
type Refusals = Record<string, { refused: string[]; accepts?: string[] }>;

let refusals: Refusals | null = null;

function refusalsPath(): string {
  return path.join(getUserDataPath(), "cache", "computer-native-rejected.json");
}

/** The dated computer tool versions the installed SDK has, newest first. */
export function anthropicComputerVersions(): string[] {
  return Object.keys(anthropic.tools)
    .filter((k) => /^computer_\d{8}$/.test(k))
    .sort()
    .reverse();
}

function refusalsMap(): Refusals {
  if (refusals) return refusals;
  try {
    const raw = JSON.parse(fs.readFileSync(refusalsPath(), "utf-8")) as unknown;
    // 15.11.0 wrote bare keys: the model refused the version it sent then, the newest.
    refusals = Array.isArray(raw)
      ? Object.fromEntries(raw.map((k) => [String(k), { refused: ["computer_20251124"] }]))
      : ((raw ?? {}) as Refusals);
  } catch {
    refusals = {};
  }
  return refusals;
}

function refusalText(err: unknown): string {
  const e = err as { message?: unknown; responseBody?: unknown; error?: { message?: unknown; responseBody?: unknown } };
  return [e?.message, e?.responseBody, e?.error?.message, e?.error?.responseBody]
    .filter((p): p is string => typeof p === "string")
    .join("\n");
}

/**
 * The native Anthropic computer version to send this model: what its refusal
 * named, else the newest it has not refused. Null: none left (our own tool).
 */
export function anthropicComputerVersion(m: ComputerModel): string | null {
  const r = refusalsMap()[computerUseKey(m)];
  const left = anthropicComputerVersions().filter((v) => !r?.refused.includes(v));
  if (r?.accepts) return left.find((v) => r.accepts!.includes(v)) ?? null;
  return left[0] ?? null;
}

/**
 * The provider refused the native computer tool it was sent. `version`: the
 * Anthropic version sent (absent: the tool as a whole, our own from now on).
 * A refusal that lists the tool types the model takes ("Did you mean …")
 * decides the next version; one that lists no dated computer version means
 * none will do.
 */
export function rememberNativeRejected(m: ComputerModel & { version?: string }, err?: unknown): void {
  const map = refusalsMap();
  const key = computerUseKey(m);
  const all = anthropicComputerVersions();
  const entry = map[key] ?? { refused: [] };
  if (!m.version) {
    entry.refused = all;
  } else {
    if (!entry.refused.includes(m.version)) entry.refused.push(m.version);
    const text = refusalText(err);
    const named = text.split(/did you mean/i)[1];
    if (named != null) entry.accepts = [...new Set(named.match(/\bcomputer_\d{8}\b/g) ?? [])];
  }
  map[key] = entry;
  try {
    const file = refusalsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map));
  } catch {
    // Remembered for this process at least.
  }
}

export function computerLane(m: ComputerModel): ComputerLane | null {
  if (!m.name || !isComputerUseOn(m)) return null;
  if (computerUseIneligible(m)) return null;
  if (!hasNativeComputerTool(m.name)) return "own";
  const provider = providerOf(m);
  const anthropicFormat =
    provider === "anthropic" ||
    isCustomAnthropicFormat(provider) ||
    (provider === "bedrock" && /(^|\.)anthropic\./i.test(m.name));
  if (anthropicFormat) return anthropicComputerVersion(m) ? "native-anthropic" : "own";
  if (provider === "openai") return refusalsMap()[computerUseKey(m)] ? "own" : "native-openai";
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
  refusals = null;
  bothGranted = false;
}
