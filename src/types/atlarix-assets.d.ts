/**
 * Files the headless/CLI build carries with it. Provided by the build:
 * scripts/build-bun.ts generates it (embedded files), scripts/build-headless.mjs
 * aliases it to src/runtime/assets-node.ts (files shipped beside the bundle).
 */
declare module "atlarix:assets" {
  export const assets: {
    agentsMd?: string;
    modelsSnapshot?: string;
    /** The MCP marketplace catalog (official MCP Registry) for offline first runs. */
    mcpRegistrySnapshot?: string;
    tiktokenWasm?: string;
    /** The QuickJS engine mods run in (mod-host.ts). */
    quickjsWasm?: string;
    rg?: string;
    /** The Chrome bridge relay, when built for this target. */
    relay?: string;
    /** The computer-use executor, when built for this target. */
    computer?: string;
    /** The bundled skills (src/skills), by their path under it: "modes/build-mode.md" → file. */
    skills?: Record<string, string>;
  };
}
