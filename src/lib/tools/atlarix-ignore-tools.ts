/**
 * .atlarixignore — read in Ask/Plan; update in Build with approval.
 */

import { ToolRegistry, ToolCategory, createParameters, stringParam } from "./registry";
import {
  ATLARIX_IGNORE_FILENAME,
  ensureDefaultAtlarixIgnore,
  readAtlarixIgnoreSource,
} from "@/lib/atlarix/atlarix-ignore";

ToolRegistry.register({
  name: "get_atlarixignore",
  description:
    "Read the project's .atlarixignore file (gitignore-style globs for Blueprint/RTE). Use during Plan analysis to see what is excluded from parsing.",
  category: ToolCategory.DIAGRAM,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters({ workspace: stringParam("Workspace root path (auto-injected)") }, []),
  handler: async ({ workspace }: { workspace?: string }) => {
    if (!workspace) return { success: false, error: "Workspace path required" };
    await ensureDefaultAtlarixIgnore(workspace);
    const content = await readAtlarixIgnoreSource(workspace);
    return { success: true, path: ATLARIX_IGNORE_FILENAME, content };
  },
});

ToolRegistry.register({
  name: "update_atlarixignore",
  description:
    "Replace .atlarixignore with full file content (gitignore syntax). Build mode only — requires user approval. Suggest patterns; do not overwrite without user consent.",
  category: ToolCategory.DIAGRAM,
  cost: 2,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspace: stringParam("Workspace root path (auto-injected)"),
      content: stringParam("Complete .atlarixignore file content"),
      description: stringParam("Why these patterns are being set"),
    },
    ["content", "description"],
  ),
  handler: async ({
    workspace,
    content,
    description,
  }: {
    workspace?: string;
    content: string;
    description: string;
  }) => {
    if (!workspace) return { success: false, error: "Workspace path required" };
    return {
      __permission_required: true,
      operation: "write_file",
      preview: {
        path: ATLARIX_IGNORE_FILENAME,
        content,
        description: description || "Update .atlarixignore",
        type: "update",
        lines: content.split("\n").length,
      },
      reasoning: description,
    };
  },
});
