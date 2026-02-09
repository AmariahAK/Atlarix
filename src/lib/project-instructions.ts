/**
 * v2.1: Project instruction files (ATLARIX.md)
 * Precedence (lowest to highest): Bundle AGENTS.md < Global ~/.atlarix/ATLARIX.md < Workspace prompts (DB) < AI_RULES.md < .atlarix/ATLARIX.md (project)
 */

import path from "node:path";
import fs from "node:fs";
import { getUserDataPath } from "../paths/paths";
import log from "electron-log";

const logger = log.scope("project-instructions");

const ATLARIX_DIR = ".atlarix";
const ATLARIX_MD = "ATLARIX.md";
const AI_RULES_MD = "AI_RULES.md";

/** Path to global user instruction file. */
export function getGlobalAtlarixMdPath(): string {
  return path.join(getUserDataPath(), ATLARIX_DIR, ATLARIX_MD);
}

/** Path to project instruction file (inside workspace). */
export function getProjectAtlarixMdPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR, ATLARIX_MD);
}

/** Path to AI_RULES.md in workspace. */
export function getAiRulesPath(workspacePath: string): string {
  return path.join(workspacePath, AI_RULES_MD);
}

export async function readGlobalAtlarixMd(): Promise<string> {
  const p = getGlobalAtlarixMdPath();
  try {
    return await fs.promises.readFile(p, "utf8");
  } catch {
    return "";
  }
}

export async function readProjectAtlarixMd(workspacePath: string): Promise<string> {
  if (!workspacePath) return "";
  const p = getProjectAtlarixMdPath(workspacePath);
  try {
    return await fs.promises.readFile(p, "utf8");
  } catch {
    return "";
  }
}

export async function readAiRulesMd(workspacePath: string): Promise<string> {
  if (!workspacePath) return "";
  try {
    return await fs.promises.readFile(getAiRulesPath(workspacePath), "utf8");
  } catch {
    return "";
  }
}

export async function writeGlobalAtlarixMd(content: string): Promise<void> {
  const dir = path.dirname(getGlobalAtlarixMdPath());
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(getGlobalAtlarixMdPath(), content, "utf8");
  logger.info("Wrote global ATLARIX.md");
}

export async function writeProjectAtlarixMd(workspacePath: string, content: string): Promise<void> {
  if (!workspacePath) return;
  const dir = path.dirname(getProjectAtlarixMdPath(workspacePath));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(getProjectAtlarixMdPath(workspacePath), content, "utf8");
  logger.info("Wrote project ATLARIX.md at", workspacePath);
}

export async function existsGlobalAtlarixMd(): Promise<boolean> {
  try {
    await fs.promises.access(getGlobalAtlarixMdPath());
    return true;
  } catch {
    return false;
  }
}

export async function existsProjectAtlarixMd(workspacePath: string): Promise<boolean> {
  if (!workspacePath) return false;
  try {
    await fs.promises.access(getProjectAtlarixMdPath(workspacePath));
    return true;
  } catch {
    return false;
  }
}

export interface InstructionLayer {
  key: "bundle" | "global" | "workspace" | "aiRules" | "project";
  label: string;
  content: string;
  exists: boolean;
  path?: string;
}

/**
 * Load all instruction layers in precedence order (bundle first, then global, workspace, aiRules, project last).
 * Caller can concatenate with "\n\n" so project has final say.
 */
export async function loadInstructionLayers(params: {
  workspacePath: string;
  workspacePromptContent: string | null;
  bundleAgentsContent: string;
}): Promise<InstructionLayer[]> {
  const { workspacePath, workspacePromptContent, bundleAgentsContent } = params;
  const globalContent = await readGlobalAtlarixMd();
  const projectContent = await readProjectAtlarixMd(workspacePath);
  const aiRulesContent = await readAiRulesMd(workspacePath);

  return [
    {
      key: "bundle",
      label: "System (AGENTS.md)",
      content: bundleAgentsContent,
      exists: !!bundleAgentsContent,
    },
    {
      key: "global",
      label: "User global",
      content: globalContent,
      exists: !!globalContent,
      path: getGlobalAtlarixMdPath(),
    },
    {
      key: "workspace",
      label: "Workspace prompts",
      content: workspacePromptContent ?? "",
      exists: !!(workspacePromptContent && workspacePromptContent.trim()),
    },
    {
      key: "aiRules",
      label: "AI_RULES.md",
      content: aiRulesContent,
      exists: !!aiRulesContent,
      path: workspacePath ? getAiRulesPath(workspacePath) : undefined,
    },
    {
      key: "project",
      label: "Project (.atlarix/ATLARIX.md)",
      content: projectContent,
      exists: !!projectContent,
      path: workspacePath ? getProjectAtlarixMdPath(workspacePath) : undefined,
    },
  ];
}

/**
 * Build combined instruction string in precedence order: bundle + global + workspace + aiRules + project.
 * So project content comes last and overrides in spirit (we don't parse, we concatenate).
 */
export function buildInstructionsFromLayers(layers: InstructionLayer[]): string {
  const parts: string[] = [];
  for (const layer of layers) {
    if (layer.content.trim()) {
      parts.push(layer.content.trim());
    }
  }
  return parts.join("\n\n");
}
