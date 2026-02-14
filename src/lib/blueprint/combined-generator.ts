/**
 * Combined Blueprint generator: multiple projects -> one CombinedBlueprint with cross_project_edges.
 */

import type { CombinedBlueprint, ProjectBlueprint, CrossProjectEdge, BlueprintNodeSummary, ProjectMarker } from "@/shared/blueprint-types";
import type { ProjectCandidate } from "./project-selector";
import { generateBlueprint } from "./rte/parsers";
import type { BlueprintNode } from "./rte/parsers/types";

const FRONTEND_FRAMEWORKS = new Set(["next.js", "react", "vue", "svelte", "remix", "nuxt"]);
const BACKEND_FRAMEWORKS = new Set(["express", "fastify", "nestjs", "fastapi", "django", "flask", "hono"]);

function inferMarker(candidate: ProjectCandidate, frameworkName?: string): ProjectMarker {
  const fw = (frameworkName ?? candidate.framework ?? "").toLowerCase();
  if (FRONTEND_FRAMEWORKS.has(fw) || fw.includes("react") || fw.includes("next")) return "frontend";
  if (BACKEND_FRAMEWORKS.has(fw) || fw.includes("api") || fw.includes("express") || fw.includes("fastapi")) return "backend";
  if (fw.includes("mobile") || fw.includes("react-native") || fw.includes("expo")) return "mobile";
  if (candidate.path.includes("packages") || candidate.path.includes("shared")) return "shared";
  return "api";
}

function nodeToSummary(n: BlueprintNode): BlueprintNodeSummary {
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    file: n.file,
    line: n.line,
    description: n.description,
    method: n.method,
    path: n.path,
  };
}

/**
 * Generate a combined blueprint from selected project candidates.
 */
export async function generateCombinedBlueprint(
  selectedProjects: ProjectCandidate[]
): Promise<CombinedBlueprint> {
  const projects: ProjectBlueprint[] = [];
  const allNodesByProject: { projectId: string; nodes: BlueprintNode[] }[] = [];

  for (const candidate of selectedProjects) {
    const result = await generateBlueprint(candidate.path);
    const frameworkName = result?.framework?.name;
    const marker = inferMarker(candidate, frameworkName);
    const nodes = result?.nodes ?? [];
    const summaries = nodes.map(nodeToSummary);
    projects.push({
      id: candidate.id,
      name: candidate.name,
      path: candidate.path,
      language: candidate.language,
      framework: frameworkName ?? candidate.framework,
      marker,
      nodes: summaries,
    });
    allNodesByProject.push({ projectId: candidate.id, nodes });
  }

  const cross_project_edges = detectCrossProjectEdges(projects, allNodesByProject);

  return {
    version: "2.2",
    type: selectedProjects.length > 1 ? "combined" : "single",
    projects,
    cross_project_edges,
  };
}

/**
 * Detect edges from frontend API calls to backend routes (by path/method).
 */
export function detectCrossProjectEdges(
  projects: ProjectBlueprint[],
  allNodesByProject: { projectId: string; nodes: BlueprintNode[] }[]
): CrossProjectEdge[] {
  const edges: CrossProjectEdge[] = [];
  const frontends = projects.filter((p) => p.marker === "frontend");
  const backends = projects.filter((p) => p.marker === "backend" || p.marker === "api");

  for (const fe of frontends) {
    const feNodes = allNodesByProject.find((x) => x.projectId === fe.id)?.nodes ?? [];
    const feApiCalls = feNodes.filter((n) => n.type === "api" || n.path || (n.description && /\/api\//.test(n.description)));
    for (const be of backends) {
      const beNodes = allNodesByProject.find((x) => x.projectId === be.id)?.nodes ?? [];
      const beRoutes = beNodes.filter((n) => n.type === "api" && n.path);
      for (const call of feApiCalls) {
        const callPath = call.path ?? call.description;
        if (!callPath) continue;
        const normalizedCall = callPath.replace(/^.*\/api/, "/api").split("?")[0];
        const matching = beRoutes.find((r) => {
          const rPath = (r.path ?? "").replace(/\{[^}]+\}/g, "*");
          return normalizedCall === rPath || normalizedCall.startsWith(rPath + "/");
        });
        if (matching) {
          edges.push({
            from: `${fe.id}:${call.id}`,
            to: `${be.id}:${matching.id}`,
            type: "api_call",
            method: call.method ?? matching.method,
            path: normalizedCall,
          });
        }
      }
    }
  }

  return edges;
}
