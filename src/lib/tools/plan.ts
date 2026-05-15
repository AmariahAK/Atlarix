/**
 * Plan tools — implementation plan file management (.atlarix/ATLARIX_PLAN.md).
 *
 * Previously bundled in blueprint-tools.ts. Plan files are an independent feature
 * from Blueprint and survived the Pass 7 Blueprint removal.
 */

import { ToolRegistry, ToolCategory, createParameters, stringParam } from "./registry";

export const PLAN_FILENAME = "ATLARIX_PLAN.md";
export const PLAN_DIR = ".atlarix";

function getPlanPath(targetPath?: string): string {
  const normalizedTarget = (targetPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalizedTarget ? `${normalizedTarget}/${PLAN_DIR}` : PLAN_DIR;
  return `${base}/${PLAN_FILENAME}`;
}

ToolRegistry.register({
  name: "get_plan_scope",
  description:
    "Determine where to put .atlarix/ATLARIX_PLAN.md. Uses git (if present) and project structure. Returns suggested targetPaths. Call before write_implementation_plan for multi-repo/polyproject.",
  category: ToolCategory.TASK,
  cost: 2,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters(
    { workspace: stringParam("Workspace root path (auto-injected)") },
    []
  ),
  handler: async ({ workspace }: { workspace?: string }) => {
    if (!workspace) return { success: false, error: "Workspace path required" };
    const pathMod = await import("path");
    const fs = await import("fs/promises");

    const structure: {
      type: "single" | "monorepo" | "polyproject";
      suggestedPaths: string[];
      hasGit: boolean;
      modules: string[];
    } = {
      type: "single",
      suggestedPaths: [],
      hasGit: false,
      modules: [],
    };

    try {
      try {
        await fs.access(pathMod.join(workspace, ".git"));
        structure.hasGit = true;
      } catch {
        structure.hasGit = false;
      }

      const entries = await fs.readdir(workspace, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
      const rootHasPackageJson = await fs
        .access(pathMod.join(workspace, "package.json"))
        .then(() => true)
        .catch(() => false);

      const monorepoDirs = ["packages", "apps", "frontend", "backend", "web", "api", "server", "client"];
      const found = dirs.filter((d) => monorepoDirs.includes(d));
      const packageDirs: string[] = [];
      for (const d of dirs) {
        try {
          await fs.access(pathMod.join(workspace, d, "package.json"));
          packageDirs.push(d);
        } catch {
          /* not a package dir */
        }
      }

      if (found.length >= 2) {
        structure.type = "monorepo";
        structure.modules = found;
        structure.suggestedPaths = [""];
      } else if (!rootHasPackageJson && packageDirs.length === 1) {
        structure.type = "single";
        structure.modules = packageDirs;
        structure.suggestedPaths = [packageDirs[0], ""];
      } else if (found.length === 1) {
        structure.type = "polyproject";
        structure.modules = found;
        structure.suggestedPaths = ["", ...found];
      } else {
        structure.type = "single";
        structure.suggestedPaths = [""];
      }
    } catch (err: any) {
      return { success: false, error: err?.message ?? String(err) };
    }

    return {
      success: true,
      ...structure,
      guidance:
        structure.type === "single"
          ? structure.modules.length === 1 && structure.suggestedPaths[0]
            ? `Single project detected in subfolder '${structure.suggestedPaths[0]}': use targetPath='${structure.suggestedPaths[0]}' unless user wants root-level plan.`
            : "Single project: use targetPath omitted (plan at root)."
          : structure.type === "monorepo"
            ? "Monorepo: one .atlarix/ATLARIX_PLAN.md at root with ## Frontend, ## Backend sections. Or one per module if user scope is narrow."
            : "Polyproject: use targetPath for each module being updated (e.g. 'frontend', 'backend'). Only create plans in repos user asked to change.",
    };
  },
});

ToolRegistry.register({
  name: "read_implementation_plan",
  description:
    "Read .atlarix/ATLARIX_PLAN.md. Use at start of turn or when user says ready for next task. One exchange = one task. Optional targetPath for subprojects (e.g. 'frontend').",
  category: ToolCategory.TASK,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters(
    {
      workspace: stringParam("Workspace root path (auto-injected)"),
      targetPath: {
        type: "string",
        description:
          "Optional. For multi-repo/polyproject: subpath (e.g. 'frontend', 'packages/api'). Omit for single project.",
        required: false,
      },
    },
    []
  ),
  handler: async ({ workspace, targetPath }: { workspace?: string; targetPath?: string }) => {
    if (!workspace) return { success: false, error: "Workspace path required" };
    const pathMod = await import("path");
    const fs = await import("fs/promises");
    const planPath = getPlanPath(targetPath);
    const fullPath = pathMod.join(workspace, planPath);
    const { assertReadablePath } = await import("@/lib/security/env-secret-paths");
    assertReadablePath(planPath, workspace);
    try {
      const content = await fs.readFile(fullPath, "utf8");
      return { success: true, content, path: planPath };
    } catch (err: any) {
      if (err?.code === "ENOENT") return { success: true, content: null, path: planPath, message: "No plan file yet." };
      return { success: false, error: err?.message ?? String(err) };
    }
  },
});

ToolRegistry.register({
  name: "write_implementation_plan",
  description:
    "Create/update .atlarix/ATLARIX_PLAN.md. Use after architecture exploration is complete. Be detailed, accurate, thorough. Optional targetPath for multi-repo (e.g. 'frontend'). Implement one task per exchange; after each, ask user to review/test and fix bugs. **Plan mode only** — not available in Ask mode.",
  category: ToolCategory.TASK,
  cost: 3,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  // Plan-mode-specific: gated above the mode allowlists in chat_stream_handlers.
  allowInAskMode: false,
  parameters: createParameters(
    {
      workspace: stringParam("Workspace root path (auto-injected)"),
      content: stringParam("Full markdown content of the plan (tasks, order, notes). Be detailed and thorough."),
      description: stringParam("Brief description of what this plan does"),
      targetPath: {
        type: "string",
        description:
          "Optional. For multi-repo: subpath where plan goes (e.g. 'frontend', 'packages/api'). Omit for single project.",
        required: false,
      },
    },
    ["content"]
  ),
  handler: async ({
    workspace,
    content,
    description,
    targetPath,
  }: {
    workspace?: string;
    content: string;
    description?: string;
    targetPath?: string;
  }) => {
    if (!workspace) return { success: false, error: "Workspace path required" };
    const pathMod = await import("path");
    const fs = await import("fs/promises");
    const planPath = getPlanPath(targetPath);
    const fullPath = pathMod.join(workspace, planPath);
    let fileType: "create" | "update" = "create";
    let oldContent: string | undefined;
    const { assertReadablePath } = await import("@/lib/security/env-secret-paths");
    assertReadablePath(planPath, workspace);
    try {
      await fs.access(fullPath);
      fileType = "update";
      oldContent = await fs.readFile(fullPath, "utf8");
    } catch {
      fileType = "create";
    }
    return {
      __permission_required: true,
      operation: "write_file",
      preview: {
        path: planPath,
        content,
        ...(oldContent !== undefined && { oldContent }),
        description: description ?? "Implementation plan",
        type: fileType,
        lines: content.split("\n").length,
      },
      reasoning: `${fileType === "update" ? "Updating" : "Creating"} ${planPath}: ${description ?? "implementation plan"}`,
    };
  },
});
