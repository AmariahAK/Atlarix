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

/** The shipped `skills/` folder (build-headless.mjs copies src/skills), as path → file. */
function shippedSkills(): Record<string, string> | undefined {
  const dir = path.join(here, "skills");
  if (!fs.existsSync(dir)) return undefined;
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (rel.endsWith(".md")) out[rel.split(path.sep).join("/")] = path.join(dir, rel);
  }
  return out;
}

export const assets = {
  agentsMd: shipped("AGENTS.md"),
  skills: shippedSkills(),
  modelsSnapshot: shipped("models-snapshot.json.gz"),
};
