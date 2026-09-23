/**
 * Workstation identity block: model names itself; Atlarix is the host environment.
 */

import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import {
  resolveAtlarixCoreIdentity,
  type AtlarixCoreTierPresentation,
} from "@/lib/atlarix-core-catalog";
import { formatModelApiNameForDisplay } from "@/lib/format-openrouter-model-label";
import { isCompassTierId } from "@/shared/compass_product_copy";

const PROVIDER_BRANDS: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  togetherai: "Together AI",
  mistral: "Mistral",
  xai: "xAI",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  azure: "Azure",
  vertex: "Google Vertex",
  bedrock: "Amazon Bedrock",
  auto: "Auto",
};

export function providerBrandName(providerId: string): string {
  const key = providerId.trim().toLowerCase();
  if (PROVIDER_BRANDS[key]) return PROVIDER_BRANDS[key];
  if (!key) return "your provider";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export { formatModelApiNameForDisplay };

export type ActiveModelIdentity = {
  modelDisplayName: string;
  providerBrand: string;
  /** Full line for prompts/UI: `deepseek v4 pro (openrouter)` */
  labelWithProvider?: string;
};

export function resolveActiveModelIdentity(
  model: LargeLanguageModel,
  settings?: UserSettings | null,
  catalog?: AtlarixCoreTierPresentation[],
): ActiveModelIdentity {
  if (model.provider === "compass" || isCompassTierId(model.name)) {
    const core = resolveAtlarixCoreIdentity(model.name, catalog);
    return {
      modelDisplayName: core.modelDisplayName,
      providerBrand: core.providerSlug,
      labelWithProvider: core.labelWithProvider,
    };
  }
  const modelDisplayName = formatModelApiNameForDisplay(model.name);
  const providerBrand = providerBrandName(model.provider).toLowerCase();
  return {
    modelDisplayName,
    providerBrand,
    labelWithProvider: `${modelDisplayName} (${providerBrand})`,
  };
}

export function buildWorkstationIdentityBlock(args: {
  modelDisplayName: string;
  providerBrand: string;
  appVersion: string;
  labelWithProvider?: string;
  /**
   * Absolute path to this workspace's memory store, or omitted when there is no
   * workspace (chat-only has none).
   *
   * It is published HERE, at the top beside the model name, rather than only in a
   * mid-prompt context section — because an agent that has not read the location
   * yet by the time it decides what to do goes looking for it. Observed: a model
   * spent ~15 tool calls running `find` for MEMORY.md and settled on a stale
   * hand-made copy, with the resolved path in its context the whole time.
   *
   * Only the PATH belongs in this block. It is stable per workspace, and this
   * block is part of the prompt-cache prefix — the note COUNT and the index stay
   * in the per-turn section, because putting them here would churn the cache on
   * every memory write (the same reason `freemem()` is kept out of the device
   * line in `system_prompt.ts`).
   */
  memoryDir?: string;
  /**
   * Absolute path of the open workspace — the agent's project root.
   *
   * A missing FACT, not a guard. `tool_contract` tells the agent an absolute path
   * is the only spelling that reaches outside the workspace, while the prompt gave
   * it no root to build one from — so an agent needing one had to guess.
   *
   * How that surfaced: on 2026-08-29 an agent in `/Users/…/Github/supabase-auth`
   * spent six tool calls against `/Users/…/Github/supabase-auth-jdv5y5`, inverting
   * the memory directory back into a path — `workspaceSlug()` renders the workspace
   * path with `/` → `-` and appends a hash, so the store name reads like a project
   * path with a suffix, and it was the only absolute path in the prompt naming the
   * project. **Model-dependent, and the logs say so:** DeepSeek V4 Pro ran 7 turns
   * across three workspaces with no memory store and never did this; the one
   * inversion was `openrouter/openrouter/free`. That is why the fix is this line
   * and NOT defensive prose on the memory line — a weak inference is not worth
   * paying for in the cache prefix on every turn of every user.
   *
   * Stable per workspace, like `memoryDir`, so this stays cache-prefix safe.
   */
  workspaceRoot?: string;
  /**
   * Absolute path to this workspace's scratch directory.
   *
   * Published for the same reason `memoryDir` is: an agent that has not been
   * told where to put a temp file picks one, and what it picks is `/tmp`. Those
   * files then sit beside the user's own and can never be swept, because a sweep
   * that went near them would be one bad glob from deleting something
   * irreplaceable. Naming a directory fixes the guess and the cleanup at once.
   *
   * Stable per workspace, so it stays cache-prefix safe beside the other two.
   */
  scratchDir?: string;
}): string {
  const { modelDisplayName, providerBrand, appVersion } = args;
  const selfLabel =
    args.labelWithProvider ??
    `${modelDisplayName} (${providerBrand.toLowerCase()})`;
  return `# Runtime identity
You are **${modelDisplayName}**, running inside **Atlarix** — an agent workstation for software development.
**Atlarix** ([atlarix.dev](https://atlarix.dev)) is built by **NorahLabs** ([norahlabs.com](https://norahlabs.com/)). Atlarix provides your tools, workspace context, and session memory.
Refer to yourself as **${selfLabel}**.
Do not call yourself "Atlarix AI" or claim to be a product of Atlarix — Atlarix is the workstation you run inside, not your maker or your name. Never reference internal model-routing tier names; you are simply the model named above.
**App shell version:** \`${appVersion}\`${
    args.workspaceRoot
      ? `\n**Workspace root:** \`${args.workspaceRoot}\` — the open project, and the absolute path to build any other from.`
      : ""
  }${
    args.memoryDir
      ? `\n**Project memory (the only store):** \`${args.memoryDir}\` — read and write notes there and nowhere else; do not search for another location.`
      : ""
  }${
    args.scratchDir
      ? `\n**Scratch space:** \`${args.scratchDir}\` — temp files go here, not /tmp. Cleaned up for you.`
      : ""
  }
If asked who built Atlarix, say **NorahLabs** ([norahlabs.com](https://norahlabs.com/)). If asked what you are, identify as **${selfLabel}** running inside Atlarix — not as Atlarix itself.`;
}
