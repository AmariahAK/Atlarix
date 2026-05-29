/**
 * Built-in skill guides shipped under src/skills/guides/ (always available).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type BuiltinGuide = {
  id: string;
  name: string;
  tags: string[];
  content: string;
};

const BUILTIN_GUIDES: Array<{ id: string; name: string; tags: string[]; file: string }> = [
  {
    id: "visual-artifacts",
    name: "Visual Artifacts",
    tags: ["visual", "artifact", "graph", "markmap", "chart", "table", "diagram"],
    file: "visual-artifacts.md",
  },
];

function resolveGuidesRoot(): string[] {
  const roots: string[] = [
    path.join(process.cwd(), "src", "skills", "guides"),
    path.join(__dirname, "../../skills/guides"),
    path.join(__dirname, "../../../src/skills/guides"),
  ];
  try {
    const { app } = require("electron") as {
      app?: { getAppPath?: () => string; isPackaged?: boolean };
    };
    if (app?.getAppPath) {
      roots.unshift(path.join(app.getAppPath(), "src", "skills", "guides"));
    }
    if (app?.isPackaged) {
      roots.unshift(path.join(process.resourcesPath, "skills", "guides"));
    }
  } catch {
    /* not in Electron */
  }
  return roots;
}

function readGuideFile(filename: string): string {
  for (const root of resolveGuidesRoot()) {
    const full = path.join(root, filename);
    try {
      if (fs.existsSync(full)) {
        return fs.readFileSync(full, "utf-8");
      }
    } catch {
      /* try next */
    }
  }
  return "";
}

export function loadBuiltinGuides(filter?: string): BuiltinGuide[] {
  const f = filter?.trim().toLowerCase();
  return BUILTIN_GUIDES.filter((g) => {
    if (!f) return true;
    if (g.id.includes(f) || g.name.toLowerCase().includes(f)) return true;
    return g.tags.some((t) => t.includes(f));
  })
    .map((g) => ({
      id: g.id,
      name: g.name,
      tags: g.tags,
      content: readGuideFile(g.file),
    }))
    .filter((g) => g.content.length > 0);
}

export function loadVisualArtifactsGuide(): string {
  const guides = loadBuiltinGuides("visual-artifacts");
  return guides[0]?.content ?? "";
}
