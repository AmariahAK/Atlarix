/**
 * Lightweight repo orientation for cold sessions — no Blueprint parse.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  numberParam,
  stringParam,
} from "./registry";
import { analyzeWorkspaceDiscovery } from "../../ipc/utils/workspace-discovery";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "venv",
  ".venv",
  "__pycache__",
  ".turbo",
  "coverage",
  ".cache",
  "cdk.out",
  ".cdk-out-deploy",
  ".cdk-staging",
  ".aws-sam",
  "target",
  "vendor",
  ".nx",
  "site-packages",
]);

const README_NAMES = ["README.md", "readme.md", "README.MD", "README.rst", "readme.rst"];
const ENTRY_RE = /(^|\/)?(main|index|app|server)\.(ts|tsx|js|jsx|py|go|rs)$/i;
const DEP_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
];

const MAX_OUTPUT_LINES = 200;
const README_EXCERPT_LINES = 60;

export interface RepoOverviewOptions {
  workspaceRoot: string;
  workspaceName?: string;
  focusPath?: string;
  maxDepth?: number;
}

export interface RepoOverviewResult {
  success: boolean;
  markdown?: string;
  error?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function buildStructureLines(root: string, relBase: string, maxDepth: number): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth) return;
    const entries = await readDirSafe(dir);
    const sorted = entries.sort((a, b) => a.localeCompare(b));
    for (const name of sorted) {
      if (name.startsWith(".") && name !== ".github") continue;
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      const indent = "  ".repeat(depth);
      if (stat.isDirectory()) {
        if (IGNORE_DIRS.has(name)) {
          lines.push(`${indent}- 📁 ${relPath}/ (skipped)`);
          continue;
        }
        lines.push(`${indent}- 📁 ${relPath}/`);
        if (depth < maxDepth) await walk(full, relPath, depth + 1);
      } else {
        lines.push(`${indent}- ${relPath}`);
      }
    }
  };
  await walk(root, relBase, 0);
  return lines;
}

/** Bounded tree walk — avoids minutes-long full-repo enumeration on huge workspaces. */
const REPO_OVERVIEW_MAX_WALK_FILES = 3000;
const REPO_OVERVIEW_MAX_WALK_DEPTH = 14;

async function collectLanguageStats(root: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  type Frame = { dir: string; depth: number };
  const stack: Frame[] = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length > 0 && scanned < REPO_OVERVIEW_MAX_WALK_FILES) {
    const { dir, depth } = stack.pop()!;
    if (depth > REPO_OVERVIEW_MAX_WALK_DEPTH) continue;
    const entries = await readDirSafe(dir);
    for (const name of entries) {
      if (name.startsWith(".") && name !== ".github") continue;
      if (IGNORE_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else {
        scanned++;
        const ext = path.extname(name).toLowerCase() || "(no ext)";
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    }
  }
  return counts;
}

async function findReadmeExcerpt(root: string): Promise<string | null> {
  for (const name of README_NAMES) {
    const p = path.join(root, name);
    if (!(await pathExists(p))) continue;
    try {
      const raw = await fs.readFile(p, "utf-8");
      const lines = raw.split("\n").slice(0, README_EXCERPT_LINES);
      return lines.join("\n");
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Lists files under root with hard caps. Used for entry-point detection only —
 * must never walk unbounded trees (stalls streaming on large/CDK/asset trees).
 */
async function listAllFilesRelBounded(
  root: string,
  relPrefix = "",
): Promise<{ files: string[]; hitCap: boolean }> {
  const out: string[] = [];
  type Frame = { dir: string; rel: string; depth: number };
  const stack: Frame[] = [{ dir: root, rel: relPrefix, depth: 0 }];
  while (
    stack.length > 0 &&
    out.length < REPO_OVERVIEW_MAX_WALK_FILES
  ) {
    const { dir, rel, depth } = stack.pop()!;
    if (depth > REPO_OVERVIEW_MAX_WALK_DEPTH) continue;
    const entries = await readDirSafe(dir);
    for (const name of entries) {
      if (out.length >= REPO_OVERVIEW_MAX_WALK_FILES) break;
      if (name.startsWith(".") && name !== ".github") continue;
      if (IGNORE_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push({ dir: full, rel: relPath, depth: depth + 1 });
      } else {
        out.push(relPath);
      }
    }
  }
  const hitCap =
    out.length >= REPO_OVERVIEW_MAX_WALK_FILES || stack.length > 0;
  return { files: out, hitCap };
}

async function detectEntryPoints(root: string): Promise<{
  entries: string[];
  hints: string[];
  entryScanHitCap: boolean;
}> {
  const { files, hitCap } = await listAllFilesRelBounded(root);
  const entries = files.filter((f) => ENTRY_RE.test(f)).slice(0, 8);
  const hints: string[] = [];

  const pkgPath = path.join(root, "package.json");
  if (await pathExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as {
        bin?: Record<string, string>;
        scripts?: Record<string, string>;
        workspaces?: unknown;
      };
      if (pkg.bin) {
        for (const [name, target] of Object.entries(pkg.bin)) {
          hints.push(`package.json bin "${name}" → ${target}`);
        }
      }
      if (pkg.scripts?.start) hints.push(`package.json scripts.start`);
      if (pkg.workspaces) hints.push(`package.json workspaces (monorepo)`);
    } catch {
      /* ignore */
    }
  }

  const pyPath = path.join(root, "pyproject.toml");
  if (await pathExists(pyPath)) {
    hints.push(`pyproject.toml present — check [project.scripts]`);
  }

  const srcFirst = files.find((f) => /^src\/[^/]+\.(tsx?|py)$/.test(f));
  if (srcFirst) hints.push(`candidate: ${srcFirst}`);

  const rootScripts = files.filter((f) => !f.includes("/") && /\.(sh|bash)$/.test(f));
  for (const s of rootScripts.slice(0, 2)) hints.push(`executable script: ${s}`);

  return { entries, hints: hints.slice(0, 3), entryScanHitCap: hitCap };
}

async function detectDependencyFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of DEP_MANIFESTS) {
    if (await pathExists(path.join(root, name))) found.push(name);
  }
  return found;
}

async function detectSubprojects(root: string): Promise<string[]> {
  const subs: string[] = [];
  const pkgPath = path.join(root, "package.json");
  if (await pathExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as { workspaces?: string[] | { packages?: string[] } };
      const ws = pkg.workspaces;
      if (Array.isArray(ws)) subs.push(...ws.map((w) => w.replace(/\/?\*$/, "")));
      else if (ws && typeof ws === "object" && Array.isArray(ws.packages)) {
        subs.push(...ws.packages.map((w) => w.replace(/\/?\*$/, "")));
      }
    } catch {
      /* ignore */
    }
  }
  for (const dir of ["packages", "apps"]) {
    const full = path.join(root, dir);
    if (!(await pathExists(full))) continue;
    const children = await readDirSafe(full);
    for (const c of children.slice(0, 10)) {
      const childPath = path.join(full, c);
      try {
        const st = await fs.stat(childPath);
        if (st.isDirectory()) subs.push(`${dir}/${c}`);
      } catch {
        /* ignore */
      }
    }
  }
  return [...new Set(subs)].slice(0, 10);
}

/**
 * Build markdown repo overview (exported for unit tests).
 */
export async function buildRepoOverviewMarkdown(
  options: RepoOverviewOptions,
): Promise<RepoOverviewResult> {
  const { workspaceRoot, workspaceName, focusPath, maxDepth = 3 } = options;
  const root = path.resolve(workspaceRoot);
  if (!(await pathExists(root))) {
    return { success: false, error: `Workspace not accessible: ${root}` };
  }

  if (!focusPath) {
    const disc = analyzeWorkspaceDiscovery(root);
    if (disc.isMultiRepoWorkspace && disc.nestedRepoNames?.length) {
      const list = disc.nestedRepoNames.map((n) => `- \`${n}/\``).join("\n");
      const example = disc.nestedRepoNames[0] ?? "subdir";
      return {
        success: true,
        markdown: [
          `# Multi-repo workspace`,
          ``,
          `This folder has **no .git** at the root but contains **${disc.nestedRepoNames.length}** nested repo(s):`,
          ``,
          list,
          ``,
          `Call **get_repo_overview** again with \`focus_path\` set to one repo (e.g. \`${example}\`) for a scoped tree and stats. Avoid assuming a single root tree when listing files from the parent folder.`,
        ].join("\n"),
      };
    }
  }

  let base = root;
  let relFocus = "";
  if (focusPath) {
    const candidate = path.resolve(root, focusPath.replace(/^\/+/, ""));
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      return { success: false, error: "focus_path escapes workspace root." };
    }
    if (!(await pathExists(candidate))) {
      return { success: false, error: `focus_path not found: ${focusPath}` };
    }
    base = candidate;
    relFocus = path.relative(root, candidate).replace(/\\/g, "/");
  }

  const name = workspaceName ?? path.basename(root);
  const depth = Math.min(5, Math.max(1, maxDepth));
  const sections: string[] = [];
  let lineBudget = MAX_OUTPUT_LINES;
  let truncated = false;

  const push = (block: string) => {
    const lines = block.split("\n");
    if (lines.length <= lineBudget) {
      sections.push(block);
      lineBudget -= lines.length;
      return;
    }
    const kept = lines.slice(0, Math.max(0, lineBudget));
    if (kept.length > 0) sections.push(kept.join("\n"));
    lineBudget = 0;
    truncated = true;
  };

  push(`# Repo overview: ${name}${relFocus ? ` (${relFocus})` : ""}`);

  const structureLines = await buildStructureLines(base, relFocus, depth);
  let structBody = structureLines.map((l) => (l.startsWith("-") ? l : `- ${l}`)).join("\n");
  if (!structBody) structBody = "_Empty or inaccessible directory._";
  push(`\n## Top-level structure\n${structBody}`);

  const { entries, hints, entryScanHitCap } = await detectEntryPoints(base);
  if (entries.length > 0) {
    const capNote = entryScanHitCap
      ? "\n\n_(Entry detection used a bounded file sample; pass focus_path or use explore_folder if something missing.)_"
      : "";
    push(`\n## Entry points\n${entries.map((e) => `- ${e}`).join("\n")}${capNote}`);
  } else {
    const hintLine =
      hints.length > 0 ? `\nHints: ${hints.map((h) => `- ${h}`).join("\n")}` : "";
    const capNote = entryScanHitCap
      ? `\n\n_(Scan hit size/depth limits — pass **focus_path** to the relevant subfolder or use **explore_folder**.)_`
      : "";
    push(`\n## Entry points\n_No standard entry point detected._${hintLine}${capNote}`);
  }

  const deps = await detectDependencyFiles(base);
  if (deps.length > 0) {
    push(`\n## Dependency files\n${deps.map((d) => `- ${d}`).join("\n")}`);
  } else {
    push("\n## Dependency files\n_No dependency manifest found._");
  }

  const langCounts = await collectLanguageStats(base);
  const sortedLang = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (sortedLang.length > 0 && lineBudget > 0) {
    const capNote =
      ` _(sampled up to ${REPO_OVERVIEW_MAX_WALK_FILES} files / depth ${REPO_OVERVIEW_MAX_WALK_DEPTH}; pass focus_path for a narrower slice)._`;
    push(
      `\n## Dominant languages\n${sortedLang.map(([ext, n]) => `- ${ext}: ${n}`).join("\n")}${capNote}`,
    );
  }

  const subprojects = await detectSubprojects(base);
  if (subprojects.length > 0 && lineBudget > 0) {
    push(
      `\n## Subprojects\n${subprojects.map((s) => `- ${s}`).join("\n")}\n\n_Call \`get_repo_overview\` again with \`focus_path\` set to a subproject for details._`,
    );
  }

  const readme = await findReadmeExcerpt(base);
  if (readme && lineBudget > 0) {
    push(`\n## README (excerpt)\n${readme}`);
  } else if (lineBudget > 0) {
    push(`\n## README (excerpt)\n_No README found in ${relFocus || "."}._`);
  }

  if (truncated) {
    sections.push("\n_…overview truncated; call with focus_path to narrow scope_");
  }

  return { success: true, markdown: sections.join("\n") };
}

ToolRegistry.register({
  name: "get_repo_overview",
  category: ToolCategory.FILE,
  description:
    "Lightweight orientation: shallow directory tree, README excerpt, entry points (from a bounded file sample), and language stats. " +
    "On monorepos or large trees, pass focus_path (e.g. apps/web, packages/api) to scope to what the user asked about — do not rely on root-only overview for deep paths. " +
    "For ad-hoc directory listing, use explore_folder or list_files on that path instead.",
  cost: 1,
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      focus_path: stringParam(
        "Strongly recommended for monorepos and large repos: relative subfolder (e.g. apps/web, packages/api). Scans that subtree only.",
      ),
      max_depth: numberParam("Maximum directory depth (default 3, max 5)"),
    },
    [],
  ),
  handler: async ({
    workspace,
    focus_path,
    max_depth = 3,
  }: {
    workspace?: string;
    focus_path?: string;
    max_depth?: number;
  }) => {
    if (!workspace) {
      return { success: false, error: "No workspace path provided" };
    }
    const result = await buildRepoOverviewMarkdown({
      workspaceRoot: workspace,
      workspaceName: path.basename(workspace),
      focusPath: focus_path,
      maxDepth: max_depth,
    });
    if (!result.success) return result;
    return result.markdown ?? "";
  },
});
