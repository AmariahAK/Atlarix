/**
 * Project detection within a workspace for combined blueprints.
 * findProjects(workspacePath) returns project roots (monorepo apps or top-level).
 * analyzeWorkspaceWithActivity() adds activity score and recommendation (blueprint / skip / ask_user).
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Runtime } from "@/lib/workflow/app_map_types";

const INDICATORS: { file: string; lang: Runtime }[] = [
  { file: "package.json", lang: "node" },
  { file: "pyproject.toml", lang: "python" },
  { file: "requirements.txt", lang: "python" },
  { file: "go.mod", lang: "go" },
  { file: "Cargo.toml", lang: "rust" },
  { file: "Gemfile", lang: "ruby" },
  { file: "pom.xml", lang: "java" },
  { file: "build.gradle", lang: "java" },
  { file: "composer.json", lang: "php" },
  { file: "mix.exs", lang: "elixir" },
  { file: "deno.json", lang: "deno" },
  { file: "deno.jsonc", lang: "deno" },
  { file: "bun.lockb", lang: "bun" },
];

const RUNTIME_TO_LANG: Record<string, string> = {
  node: "typescript",
  bun: "typescript",
  deno: "typescript",
  python: "python",
  go: "go",
  rust: "rust",
  ruby: "ruby",
  java: "java",
  php: "php",
  elixir: "elixir",
  dotnet: "csharp",
};

export interface ProjectCandidate {
  id: string;
  name: string;
  path: string;
  language: string;
  framework?: string;
  /** Set by analyzeWorkspaceWithActivity */
  activityScore?: number;
  recommendation?: "blueprint" | "skip" | "ask_user";
  reason?: string;
}

/** Check if dir contains a project indicator file */
async function isProjectRoot(dir: string): Promise<{ lang: Runtime } | null> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const { file, lang } of INDICATORS) {
    if (names.includes(file)) return { lang };
  }
  if (names.some((n) => n.endsWith(".csproj")) || names.includes("*.sln")) return { lang: "dotnet" as Runtime };
  return null;
}

/**
 * Find all project roots under workspacePath.
 * - Includes workspacePath itself if it is a project root.
 * - Scans one level of subdirs (e.g. apps/web, apps/api) for monorepos.
 */
export async function findProjects(workspacePath: string): Promise<ProjectCandidate[]> {
  const candidates: ProjectCandidate[] = [];
  const seen = new Set<string>();

  const rootCheck = await isProjectRoot(workspacePath);
  if (rootCheck) {
    const name = path.basename(workspacePath) || "root";
    const id = `proj_${name}_0`;
    seen.add(workspacePath);
    candidates.push({
      id,
      name,
      path: workspacePath,
      language: RUNTIME_TO_LANG[rootCheck.lang] ?? rootCheck.lang,
    });
  }

  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = await fs.readdir(workspacePath, { withFileTypes: true });
  } catch {
    return candidates;
  }

  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules");
  for (const d of subdirs) {
    const childPath = path.join(workspacePath, d.name);
    if (seen.has(childPath)) continue;
    const check = await isProjectRoot(childPath);
    if (check) {
      seen.add(childPath);
      const name = d.name;
      const id = `proj_${name}_${candidates.length}`;
      candidates.push({
        id,
        name,
        path: childPath,
        language: RUNTIME_TO_LANG[check.lang] ?? check.lang,
      });
    }
  }

  return candidates;
}

const EXCLUDE_FOR_ACTIVITY = new Set(["node_modules", ".git", "dist", "build", "__pycache__", "venv", ".venv", "target"]);

export interface ActivityScore {
  editsLast7Days: number;
  editsLast30Days: number;
  lastEditedAt: number;
  fileCount: number;
}

/** Get recent activity for a project path (file mtime-based). */
export async function getRecentActivity(projectPath: string): Promise<ActivityScore> {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  let editsLast7Days = 0;
  let editsLast30Days = 0;
  let lastEditedAt = 0;
  let fileCount = 0;

  async function walk(dir: string): Promise<void> {
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!EXCLUDE_FOR_ACTIVITY.has(e.name)) await walk(full);
      } else {
        fileCount++;
        try {
          const stat = await fs.stat(full);
          const m = stat.mtimeMs;
          if (m > now - sevenDaysMs) editsLast7Days++;
          if (m > now - thirtyDaysMs) editsLast30Days++;
          if (m > lastEditedAt) lastEditedAt = m;
        } catch {
          // skip
        }
      }
    }
  }

  await walk(projectPath);
  return { editsLast7Days, editsLast30Days, lastEditedAt, fileCount };
}

const LARGE_PROJECT_THRESHOLD = 5000;

/**
 * Find projects and attach activity-based recommendation.
 * - High recent activity -> blueprint
 * - No activity 30+ days -> skip
 * - Very large project -> ask_user
 */
export async function analyzeWorkspaceWithActivity(workspacePath: string): Promise<ProjectCandidate[]> {
  const projects = await findProjects(workspacePath);
  const result: ProjectCandidate[] = [];

  for (const p of projects) {
    const activity = await getRecentActivity(p.path);
    let recommendation: "blueprint" | "skip" | "ask_user" = "blueprint";
    let reason = "Include in blueprint";

    if (activity.editsLast30Days === 0) {
      recommendation = "skip";
      reason = "Inactive for 30+ days";
    } else if (activity.editsLast7Days >= 5) {
      reason = "Actively developed";
    } else if (activity.fileCount > LARGE_PROJECT_THRESHOLD) {
      recommendation = "ask_user";
      reason = "Large project, confirm?";
    }

    result.push({
      ...p,
      activityScore: activity.editsLast7Days,
      recommendation,
      reason,
    });
  }

  return result;
}
