/**
 * Plan file restructure: .atlarix/plans/_index.md and domain-specific plan files.
 * spec.md (when present) is strictly for technical specifications.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export const PLANS_DIR = ".atlarix/plans";
export const PLANS_INDEX = "_index.md";
export const SPEC_FILE = ".atlarix/spec.md";

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

export function getSpecPath(workspacePath: string): string {
  return path.join(workspacePath, SPEC_FILE);
}

const INDEX_TEMPLATE = `# Atlarix Plans Index

- [Backend](backend.md)
- [Frontend](frontend.md)
- [Database](database.md)
- [DevOps](devops.md)

Use spec.md for technical specifications only.
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

/**
 * List domain plan file paths that exist.
 */
export async function listDomainPlans(workspacePath: string): Promise<PlanDomain[]> {
  const existing: PlanDomain[] = [];
  for (const domain of DOMAIN_PLANS) {
    try {
      await fs.access(getDomainPlanPath(workspacePath, domain));
      existing.push(domain);
    } catch {
      // skip
    }
  }
  return existing;
}

/**
 * Read _index.md content.
 */
export async function readPlansIndex(workspacePath: string): Promise<string | null> {
  try {
    return await fs.readFile(getIndexPath(workspacePath), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read a domain plan file.
 */
export async function readDomainPlan(
  workspacePath: string,
  domain: PlanDomain
): Promise<string | null> {
  try {
    return await fs.readFile(getDomainPlanPath(workspacePath, domain), "utf-8");
  } catch {
    return null;
  }
}
