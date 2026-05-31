#!/usr/bin/env node
/**
 * Run Electron Forge generateAssets + prePackage hooks (production Vite builds).
 * Uses the same listr2 path as `electron-forge package`, without electron-packager.
 */
import { Listr } from "listr2";
import { loadForgeConfig } from "./forge-config-load.mjs";

/**
 * Build listr tasks for a forge hook, calling namedHookWithTaskFn hooks with the
 * listr2 TaskWrapper (2nd arg). @electron-forge/core getHookListrTasks passes a
 * nonexistent 3rd arg, so task?.newListr is undefined and Vite never builds.
 */
function buildHookListrTasks(forgeConfig, hookName, platform, arch) {
  const hookArgs = [platform, arch];
  const tasks = [];

  const configHook = forgeConfig.hooks?.[hookName];
  if (typeof configHook === "function") {
    tasks.push({
      title: `Running ${hookName} hook from forgeConfig`,
      task: async () => configHook(forgeConfig, ...hookArgs),
    });
  }

  for (const plugin of forgeConfig.pluginInterface.plugins) {
    if (typeof plugin.getHooks !== "function") continue;
    let hooks = plugin.getHooks()[hookName];
    if (!hooks) continue;
    if (typeof hooks === "function") hooks = [hooks];

    for (const hook of hooks) {
      tasks.push({
        title: hook.__hookName || `[plugin-${plugin.name}] ${hookName}`,
        task: async (_ctx, taskWrapper) => {
          if (hook.__hookName) {
            return hook.call(taskWrapper, forgeConfig, ...hookArgs);
          }
          await hook(forgeConfig, ...hookArgs);
        },
      });
    }
  }

  return tasks;
}

async function runHookListr(forgeConfig, hookName, platform, arch) {
  const tasks = buildHookListrTasks(forgeConfig, hookName, platform, arch);
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
