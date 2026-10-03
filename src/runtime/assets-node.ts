/**
 * `atlarix:assets` for the esbuild/Node headless bundle: the files
 * scripts/build-headless.mjs copies next to the bundle. import.meta.url is the
 * bundle itself once built.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shipped = (name: string) => {
  const p = path.join(here, name);
  return fs.existsSync(p) ? p : undefined;
};

export const assets = {
  agentsMd: shipped("AGENTS.md"),
  modelsSnapshot: shipped("models-snapshot.json.gz"),
};
