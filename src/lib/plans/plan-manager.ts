/**
 * Plan file restructure: .atlarix/plans/_index.md and domain-specific plan files.
 * Project instructions live in .atlarix/atlarix.md; project knowledge in .atlarix/memory.md.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export const PLANS_DIR = ".atlarix/plans";
export const PLANS_INDEX = "_index.md";

export const DOMAIN_PLANS = ["backend", "frontend", "database", "devops"] as const;
export type PlanDomain = (typeof DOMAIN_PLANS)[number];

export function getPlansDir(workspacePath: string): string {
  return path.join(workspacePath, PLANS_DIR);
}

export function getIndexPath(workspacePath: string): string {
  return path.join(workspacePath, PLANS_DIR, PLANS_INDEX);
}

export function getDomainPlanPath(workspacePath: string, domain: PlanDomain): string {
  return path.join(workspacePath, PLANS_DIR, `${domain}.md`);
}

const INDEX_TEMPLATE = `# Atlarix Plans Index

- [Backend](backend.md)
- [Frontend](frontend.md)
- [Database](database.md)
- [DevOps](devops.md)

Use \`.atlarix/atlarix.md\` for durable project instructions and \`.atlarix/memory.md\` for project knowledge (stack, architecture, layout).
`;

const DOMAIN_TEMPLATE = (domain: string) => `# ${domain.charAt(0).toUpperCase() + domain.slice(1)} Plan

<!-- Add implementation plans and tasks here -->
`;

/**
 * Ensure .atlarix/plans exists with _index.md and optional domain stubs.
 */
export async function ensurePlansDir(
  workspacePath: string,
  options?: { createDomainStubs?: boolean }
): Promise<void> {
  const dir = getPlansDir(workspacePath);
  await fs.mkdir(dir, { recursive: true });

  const indexPath = getIndexPath(workspacePath);
  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(indexPath, INDEX_TEMPLATE, "utf-8");
  }

  if (options?.createDomainStubs) {
    for (const domain of DOMAIN_PLANS) {
      const domainPath = getDomainPlanPath(workspacePath, domain);
      try {
        await fs.access(domainPath);
      } catch {
        await fs.writeFile(domainPath, DOMAIN_TEMPLATE(domain), "utf-8");
      }
    }
  }
}

