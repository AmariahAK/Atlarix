/**
 * .atlarix/.atlarixignore — gitignore-syntax globs for Blueprint/RTE (via `ignore` package).
 */

import * as fs from "fs/promises";
import * as path from "path";
import ignore from "ignore";
import { ATLARIX_DIR, getAtlarixDirPath } from "@/lib/project-memory";

export const ATLARIX_IGNORE_FILENAME = ".atlarixignore";

/** Workspace-relative path to the ignore file. */
export const ATLARIX_IGNORE_REL = `${ATLARIX_DIR}/${ATLARIX_IGNORE_FILENAME}`;

const LEGACY_ROOT_IGNORE_REL = ATLARIX_IGNORE_FILENAME;

/** Default patterns: dependencies, build output, locks, caches, env, large data. */
export const DEFAULT_ATLARIXIGNORE = `# Atlarix — paths excluded from Blueprint / RTE (gitignore syntax)
node_modules/
**/node_modules/
.pnp/
.pnp.js
.yarn/
dist/
build/
out/
.next/
.nuxt/
.output/
coverage/
.turbo/
.parcel-cache/
.vite/
**/.vite/
.cache/
**/.cache/
*.tsbuildinfo
.next/
.vercel/
storybook-static/
__pycache__/
.venv/
venv/
*.pyc
target/
vendor/bundle/
Pods/
DerivedData/
.gradle/
*.lock
package-lock.json
yarn.lock
pnpm-lock.yaml
bun.lockb
Gemfile.lock
poetry.lock
Pipfile.lock
Cargo.lock
composer.lock
.env
.env.*
!.env.example
*.pem
*.key
*.sqlite
*.db
*.sqlite3
*.parquet
*.arrow
*.csv
*.gz
*.zip
*.tar
*.tgz
*.7z
*.rar
*.iso
*.dmg
*.mp4
*.mov
*.avi
*.mkv
*.wav
*.mp3
*.flac
*.pdf
*.woff
*.woff2
*.ttf
*.eot
*.ico
miniprogram_npm/
.git/
.hg/
.svn/
# Repo-scoped Atlarix skills (loaded by Atlarix, hidden from file-tree noise)
.atlarix/skills/
.atlarix/blueprint.json
`;

export type AtlarixIgnoreInstance = ReturnType<typeof ignore>;

export function createIgnorerFromSource(source: string): AtlarixIgnoreInstance {
  return ignore().add(source);
}

/** Normalize to repo-relative forward-slash path for matching. */
export function normalizeRelPath(projectRoot: string, filePath: string): string {
  const normRoot = path.normalize(projectRoot).replace(/\\/g, "/");
  let p = path.normalize(filePath).replace(/\\/g, "/");
  if (path.isAbsolute(filePath)) {
    if (p.startsWith(normRoot)) {
      p = path.relative(projectRoot, filePath).replace(/\\/g, "/");
    }
  }
  return p.replace(/^\.\//, "");
}

export function isRelPathIgnored(ig: AtlarixIgnoreInstance, relPath: string): boolean {
  if (!relPath) return false;
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return ig.ignores(p);
}

export function getAtlarixIgnorePath(projectRoot: string): string {
  return path.join(projectRoot, ATLARIX_IGNORE_REL);
}

function legacyRootAtlarixIgnorePath(projectRoot: string): string {
  return path.join(projectRoot, LEGACY_ROOT_IGNORE_REL);
}

async function migrateLegacyAtlarixIgnore(projectRoot: string): Promise<void> {
  const canonical = getAtlarixIgnorePath(projectRoot);
  const legacy = legacyRootAtlarixIgnorePath(projectRoot);
  try {
    await fs.access(canonical);
    return;
  } catch {
    /* migrate or create */
  }
  await fs.mkdir(getAtlarixDirPath(projectRoot), { recursive: true });
  const legacyContent = await fs.readFile(legacy, "utf-8").catch(() => null);
  if (legacyContent?.trim()) {
    await fs.writeFile(canonical, legacyContent, "utf-8");
    try {
      await fs.rename(legacy, `${legacy}.old`);
    } catch {
      /* non-fatal */
    }
    return;
  }
}

export async function readAtlarixIgnoreSource(projectRoot: string): Promise<string> {
  await migrateLegacyAtlarixIgnore(projectRoot);
  const fp = getAtlarixIgnorePath(projectRoot);
  try {
    return await fs.readFile(fp, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Create `.atlarix/.atlarixignore` with defaults if missing.
 */
export async function ensureDefaultAtlarixIgnore(projectRoot: string): Promise<void> {
  await migrateLegacyAtlarixIgnore(projectRoot);
  const fp = getAtlarixIgnorePath(projectRoot);
  try {
    await fs.access(fp);
  } catch {
    try {
      await fs.mkdir(getAtlarixDirPath(projectRoot), { recursive: true });
      await fs.writeFile(fp, DEFAULT_ATLARIXIGNORE, "utf-8");
    } catch {
      /* non-fatal */
    }
  }
}

/** Async: read disk (or empty → default patterns only). */
export async function loadIgnorerForProject(projectRoot: string): Promise<AtlarixIgnoreInstance> {
  const src = await readAtlarixIgnoreSource(projectRoot);
  if (src.trim()) return createIgnorerFromSource(src);
  return createIgnorerFromSource(DEFAULT_ATLARIXIGNORE);
}


export interface BlueprintNodeLike {
  id: string;
  file: string;
}

export function filterRteNodesByIgnore<T extends BlueprintNodeLike>(
  nodes: T[],
  ig: AtlarixIgnoreInstance,
  projectRoot: string,
): T[] {
  return nodes.filter((n) => {
    const rel = normalizeRelPath(projectRoot, n.file);
    if (!rel) return true;
    return !isRelPathIgnored(ig, rel);
  });
}

export function filterRteEdgesByNodes<T extends { from: string; to: string }>(
  edges: T[],
  keptNodeIds: Set<string>,
): T[] {
  return edges.filter((e) => keptNodeIds.has(e.from) && keptNodeIds.has(e.to));
}
