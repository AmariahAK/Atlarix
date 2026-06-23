/**
 * Standalone headless Atlarix agent CLI.
 *
 * Build: `npm run build:headless` (esbuild bundles this with electron/sentry
 * stubbed and `@/` → src; better-sqlite3 stays external).
 * Run (OpenRouter, pinned — benchmark default):
 *   node dist-headless/atlarix-headless.mjs --workspace <dir> --prompt-file <f> \
 *     --provider-id openrouter --model deepseek/deepseek-v4-pro --api-key $OPENROUTER_API_KEY \
 *     --openrouter-provider '{"order":["deepinfra"],"allow_fallbacks":false,"quantizations":["fp8"]}'
 * Run (custom OpenAI-compatible endpoint):
 *   … --provider-url https://api.deepseek.com --model deepseek-v4-pro --api-key $KEY
 *
 * Exits 0 when the turn completes (or the agent emits <task_complete>), 1 otherwise.
 */
import fs from "node:fs";
import { runHeadlessAgent } from "./headless-runner";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

async function main() {
  const workspace = arg("workspace") ?? process.cwd();
  const promptFile = arg("prompt-file");
  const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : arg("prompt");
  if (!prompt) {
    console.error("atlarix-headless: --prompt or --prompt-file is required");
    process.exit(2);
  }
  const providerId = arg("provider-id") ?? process.env.ATLARIX_HEADLESS_PROVIDER_ID; // e.g. "openrouter"
  const providerUrl =
    arg("provider-url") ?? process.env.ATLARIX_HEADLESS_PROVIDER_URL;
  const model =
    arg("model") ?? process.env.ATLARIX_HEADLESS_MODEL ?? "deepseek/deepseek-v4-pro";
  const apiKey = arg("api-key") ?? process.env.ATLARIX_HEADLESS_API_KEY;
  const openrouterProviderJson =
    arg("openrouter-provider") ?? process.env.ATLARIX_OPENROUTER_PROVIDER_JSON;
  const mode = (arg("mode") ?? "build") as "build" | "ask";
  const timeoutMs = Number(arg("timeout") ?? process.env.ATLARIX_HEADLESS_TIMEOUT_MS ?? "600000");
  // When set, the agent's final assistant message is written here (used by the
  // GitHub PR-review bot to capture the review text; stderr stays diagnostics-only).
  const outputFile = arg("output-file") ?? process.env.ATLARIX_HEADLESS_OUTPUT_FILE;

  const res = await runHeadlessAgent({
    workspaceDir: fs.realpathSync(workspace),
    prompt,
    provider: {
      // Default to the OpenRouter builtin (native FC + provider pin). Pass
      // --provider-url (without --provider-id) to use a custom OpenAI-compatible endpoint.
      id: providerId ?? (providerUrl ? undefined : "openrouter"),
      baseUrl: providerUrl,
      model,
      apiKey,
      openrouterProviderJson,
    },
    mode,
    timeoutMs,
  });

  if (outputFile) {
    fs.writeFileSync(outputFile, res.lastAssistant ?? "");
  }

  console.error(
    `[atlarix-headless] completed=${res.completed} workspace=${workspace}` +
      (outputFile ? ` output=${outputFile}` : ""),
  );
  process.exit(res.completed ? 0 : 1);
}

main().catch((err) => {
  console.error("[atlarix-headless] fatal:", err);
  process.exit(1);
});
