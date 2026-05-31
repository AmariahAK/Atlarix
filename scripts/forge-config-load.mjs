#!/usr/bin/env node
/**
 * Load forge.config — CJS default export is nested under ESM import on some Node versions.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolveLoadForgeConfig() {
  const mod = require("@electron-forge/core/dist/util/forge-config.js");
  if (typeof mod === "function") return mod;
  if (typeof mod?.default === "function") return mod.default;
  if (typeof mod?.default?.default === "function") return mod.default.default;
  throw new Error("Could not resolve loadForgeConfig from @electron-forge/core");
}

const loadForgeConfigFn = resolveLoadForgeConfig();

/** @param {string} [dir] */
export async function loadForgeConfig(dir = process.cwd()) {
  return loadForgeConfigFn(dir);
}
