/**
 * Project instruction files — aligned with `.atlarix/atlarix.md`
 * Precedence (lowest to highest): Bundle AGENTS_COMPACT.md < Global ~/.atlarix/ATLARIX.md < Workspace prompts (DB) < project atlarix.md
 */

import path from "node:path";
import fs from "node:fs";
import { getUserDataPath } from "../paths/paths";
import {
  getAtlarixMdPath,
  readAtlarixMd,
  } from "./project-memory";


const ATLARIX_DIR = ".atlarix";
const ATLARIX_MD = "ATLARIX.md";

/** Path to global user instruction file. */
export function getGlobalAtlarixMdPath(): string {
  return path.join(getUserDataPath(), ATLARIX_DIR, ATLARIX_MD);
}

/** Path to project instruction file (inside workspace). */
export function getProjectAtlarixMdPath(workspacePath: string): string {
  return getAtlarixMdPath(workspacePath);
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
  const content = await readAtlarixMd(workspacePath);
  return content ?? "";
}

export interface InstructionLayer {
  key: "bundle" | "global" | "workspace" | "project";
  label: string;
  content: string;
  exists: boolean;
  path?: string;
}

export async function loadInstructionLayers(params: {
  workspacePath: string;
  workspacePromptContent: string | null;
  bundleAgentsContent: string;
}): Promise<InstructionLayer[]> {
  const { workspacePath, workspacePromptContent, bundleAgentsContent } = params;
  const globalContent = await readGlobalAtlarixMd();
  const projectContent = await readProjectAtlarixMd(workspacePath);

  return [
    {
      key: "bundle",
      label: "System (AGENTS_COMPACT.md)",
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
      key: "project",
      label: "Project (.atlarix/atlarix.md)",
      content: projectContent,
      exists: !!projectContent,
      path: workspacePath ? getProjectAtlarixMdPath(workspacePath) : undefined,
    },
  ];
}

export function buildInstructionsFromLayers(layers: InstructionLayer[]): string {
  const parts: string[] = [];
  for (const layer of layers) {
    if (layer.content.trim()) {
      parts.push(layer.content.trim());
    }
  }
  return parts.join("\n\n");
}
