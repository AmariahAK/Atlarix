/**
 * Publish the build's own files to the modules that load them, BEFORE those
 * modules are evaluated (system_prompt.ts reads AGENTS.md at import time), so
 * the entry imports this first.
 *
 * AGENTS.md is the one that matters most. system_prompt.ts otherwise looks in
 * `cwd` first, and for the CLI and for benchmark runs `cwd` is the USER's
 * repository — which often has an AGENTS.md of its own, the common agent-
 * instructions file. That file would silently replace Atlarix's guidance.
 */
import { assets } from "atlarix:assets";

const set = (key: string, value: string | undefined) => {
  if (value && !process.env[key]) process.env[key] = value;
};

set("ATLARIX_AGENTS_FILE", assets.agentsMd);
set("ATLARIX_MODELS_SNAPSHOT", assets.modelsSnapshot);
set("ATLARIX_EMBEDDED_RG", assets.rg);
set("ATLARIX_EMBEDDED_RELAY", assets.relay);
