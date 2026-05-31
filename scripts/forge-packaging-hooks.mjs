#!/usr/bin/env node
/**
 * Run Electron Forge generateAssets + prePackage hooks (production Vite builds).
 * Uses the same listr2 path as `electron-forge package`, without electron-packager.
 */
import { Listr } from "listr2";
import { loadForgeConfig } from "./forge-config-load.mjs";

/** Minimal childTrace — hooks only need a callable wrapper. */
function childTrace(_opts, fn) {
  return fn;
}

async function runHookListr(forgeConfig, hookName, platform, arch) {
  const { getHookListrTasks } = await import("@electron-forge/core/dist/util/hook.js");
  const tasks = await getHookListrTasks(childTrace, forgeConfig, hookName, platform, arch);
  if (!tasks.length) return;
  console.log(`[forge-packaging-hooks] ${hookName} (${tasks.length} task(s))`);
  await new Listr(tasks, { concurrent: false, exitOnError: true }).run();
}

/**
 * @param {{ dir?: string, platform: string, arch: string }} opts
 */
export async function runForgePrePackageBuilds({ dir = process.cwd(), platform, arch }) {
  console.log(`[forge-packaging-hooks] loading forge.config (${platform}/${arch})`);
  const forgeConfig = await loadForgeConfig(dir);
  await runHookListr(forgeConfig, "generateAssets", platform, arch);
  await runHookListr(forgeConfig, "prePackage", platform, arch);
}
