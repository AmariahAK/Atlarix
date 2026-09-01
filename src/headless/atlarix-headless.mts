/**
 * Standalone headless Atlarix agent CLI — `atlarix run`.
 *
 * The `run` subcommand is optional and everything works without it; it exists so
 * the published `atlarix` binary has room to grow an interactive mode later
 * without this batch behaviour having to move or change shape.
 *
 * Build: `npm run build:headless` (esbuild bundles this with electron/sentry
 * stubbed and `@/` → src; better-sqlite3 stays external).
 * Run (OpenRouter, pinned — benchmark default):
 *   node dist-headless/atlarix-headless.mjs --workspace <dir> --prompt-file <f> \
 *     --provider-id openrouter --model deepseek/deepseek-v4-pro --api-key $OPENROUTER_API_KEY \
 *     --openrouter-provider '{"order":["deepinfra"],"allow_fallbacks":false,"quantizations":["fp8"]}'
 * Run (custom OpenAI-compatible endpoint):
 *   … --provider-url https://api.deepseek.com --model deepseek-v4-pro --api-key $KEY
 * Run (DeepSeek direct, native FC, at the model's reasoning ceiling — benchmark parity):
 *   … --provider-id deepseek --model deepseek-v4-flash --api-key $DEEPSEEK_API_KEY \
 *     --deep-thinking
 *
 * `--deep-thinking` (or `ATLARIX_HEADLESS_DEEP_THINKING=1`) is the app's Deep-thinking
 * toggle. Prefer `--provider-id <vendor>` over `--provider-url` when the vendor is a
 * builtin: reasoning is only placed in the request when the wire provider is known,
 * so a bare custom endpoint dispatches without it.
 *
 * `--trajectory-file <path>` streams a JSONL trace of the run (see
 * trajectory-writer.ts). Prefer it over parsing this process's console output.
 *
 * No timeout is imposed unless `--timeout` / `ATLARIX_HEADLESS_TIMEOUT_MS` says so:
 * the launcher owns the deadline, and Ctrl-C / SIGTERM end the run cleanly.
 *
 * Exits 0 when the turn completes (or the agent emits <task_complete>), 1 otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHeadlessAgent } from "./headless-runner";

// Point the catalog at the snapshot shipped beside this bundle. Without it the
// snapshot is looked for under `cwd` — the task directory in a benchmark run —
// so it is never found and the model catalog depends on reaching models.dev over
// the network. Terminal-Bench sandboxes enforce an egress allow-list that does
// not include it, and with no catalog the per-model reasoning profile is
// unavailable, which changes the SHAPE of the reasoning parameter sent. Same
// command, different request, depending on the sandbox's egress. Not overridden
// if the operator already set it.
if (!process.env.ATLARIX_MODELS_SNAPSHOT) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shipped = path.join(here, "models-snapshot.json.gz");
  if (fs.existsSync(shipped)) process.env.ATLARIX_MODELS_SNAPSHOT = shipped;
}

/**
 * Injected by esbuild (`scripts/build-headless.mjs`) from the root package.json.
 * The `typeof` guard is load-bearing: an undefined `define`d identifier is a
 * ReferenceError at the point of use, not `undefined`, so a plain `??` would
 * throw whenever this file runs unbundled (tsx, vitest).
 */
declare const __ATLARIX_HEADLESS_VERSION__: string;
const VERSION =
  typeof __ATLARIX_HEADLESS_VERSION__ === "undefined"
    ? "dev"
    : __ATLARIX_HEADLESS_VERSION__;

/**
 * `atlarix run <flags>` and bare `atlarix <flags>` are the same thing. Dropping a
 * leading `run` keeps every existing invocation working while reserving the bare
 * form for a future interactive mode, so the published binary never has to change
 * the meaning of a command someone already scripted.
 */
if (process.argv[2] === "run") process.argv.splice(2, 1);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

/** `--name` (bare) or `--name true|false|1|0|on|off`. Undefined when absent. */
function flag(name: string): boolean | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return !/^(0|false|off|no)$/i.test(next);
}

function envFlag(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return !/^(0|false|off|no)$/i.test(v);
}

async function main() {
  // Before the prompt check on purpose: `--version` is how a benchmark harness
  // records which build produced a result (Harbor calls `get_version_command()`
  // and files the answer as `agent_version`), and it must not require a task.
  // While this exited 2, harnesses fell through to reporting NODE's version.
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

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
  // Reasoning level. The app has ONE control (`deepThinking`), and it is
  // capability-derived per model rather than a global ladder: ON = the model's own
  // declared ceiling ("max" on budget-capable vendors — deepseek / qwen / minimax /
  // google; "high" where effort tops out there — openai / openrouter), OFF = one
  // notch below. Leaving it unset is what made every benchmark run so far dispatch
  // at the OFF level while published leaderboard entries all run the ceiling
  // (`reasoning_effort=max`) — a confound, not a fair reading of the model.
  const deepThinking =
    flag("deep-thinking") ?? envFlag("ATLARIX_HEADLESS_DEEP_THINKING") ?? false;
  // Unset means NO self-imposed deadline — the launcher owns it. The old
  // 10-minute default silently capped every long task (Terminal-Bench 4.0 allows
  // eight hours) and exited 1, which reads as a failed trial rather than a
  // timeout. `runHeadlessAgent` and `waitFor` both handle a non-finite value.
  const timeoutArg = arg("timeout") ?? process.env.ATLARIX_HEADLESS_TIMEOUT_MS;
  const timeoutMs = timeoutArg ? Number(timeoutArg) : undefined;
  // When set, the agent's final assistant message is written here; stderr stays
  // diagnostics-only. For a full trace use --trajectory-file instead — this is
  // just the last message.
  const outputFile = arg("output-file") ?? process.env.ATLARIX_HEADLESS_OUTPUT_FILE;
  const trajectoryFile =
    arg("trajectory-file") ?? process.env.ATLARIX_HEADLESS_TRAJECTORY_FILE;

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
    deepThinking,
    trajectoryFile,
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
