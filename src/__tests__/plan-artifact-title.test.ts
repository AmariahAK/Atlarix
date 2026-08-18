/**
 * A plan's title is STORED, not scraped out of its markdown.
 *
 * The old `createPlanArtifact` spliced the title into the body as an H1, but
 * only when the body did not already start with `#`:
 *
 *     title && !content.trim().startsWith("#")
 *
 * `## Goal` starts with `#`, so any model that opened its plan with a section
 * heading — the natural shape of a plan document, and what most of them write —
 * had its title silently discarded on write. Readers then scraped the first
 * non-empty line back out and displayed the literal word "Goal" as the plan's
 * name. None of this had a single test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Inserted = Record<string, unknown>;

let inserted: Inserted | null = null;

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (v: Inserted) => ({
        returning: () => {
          inserted = v;
          return [{ ...v, createdAt: v.createdAt ?? new Date() }];
        },
      }),
    }),
  },
}));

const { createPlanArtifact } = await import("@/lib/plans/plan-artifacts");

const SESSION = "sess-1";

beforeEach(() => {
  inserted = null;
});

describe("createPlanArtifact title handling", () => {
  it("keeps the title when the body opens with a ## section heading", async () => {
    // The exact shape that used to lose it.
    const row = await createPlanArtifact(
      SESSION,
      "## Goal\n\nShip the fix.\n\n1. [ ] Do the thing",
      "Final PR cleanup",
    );

    expect(row.title).toBe("Final PR cleanup");
    expect(inserted?.title).toBe("Final PR cleanup");
  });

  it("keeps the title when the body opens with a real H1", async () => {
    const row = await createPlanArtifact(
      SESSION,
      "# Some heading\n\n1. [ ] Step",
      "Fix cross-window sandbox mode",
    );

    expect(row.title).toBe("Fix cross-window sandbox mode");
  });

  it("no longer splices the title into the markdown body", async () => {
    // The body is stored verbatim; the title lives in its own column, so there
    // is nothing to scrape back out and nothing to drift.
    const content = "Plain prose plan, no heading at all.\n\n1. [ ] Step";
    const row = await createPlanArtifact(SESSION, content, "A real name");

    expect(row.content).toBe(content);
    expect(row.content).not.toContain("# A real name");
  });

  it("normalises a blank title to null rather than an empty string", async () => {
    const row = await createPlanArtifact(SESSION, "1. [ ] Step", "   ");
    expect(row.title).toBeNull();
  });

  it("stores null when no title is supplied", async () => {
    const row = await createPlanArtifact(SESSION, "1. [ ] Step");
    expect(row.title).toBeNull();
  });
});

/**
 * The title has to reach the MODEL, not only the UI.
 *
 * Storing the column and rendering it in the Plan panel fixed the human's view
 * and left the agent's view alone: the per-turn ledger still scraped the first
 * markdown line, so a resumed session presented a plan named "Goal" to the one
 * reader that had to act on it. These pin the precedence.
 */
describe("plan title reaches the ledger the model reads", () => {
  it("prefers the stored title over the markdown heading", async () => {
    const { formatPlanChecklistForPrompt, parsePlanChecklist } = await import(
      "@/lib/tasks/plan-checklist"
    );
    const content = "## Goal\n\nShip it.\n\n1. [ ] Do the thing";
    const stored = "Final PR cleanup";

    const line = formatPlanChecklistForPrompt(
      parsePlanChecklist(content),
      stored ?? undefined,
    )!;

    expect(line).toContain("Final PR cleanup");
    expect(line).not.toContain("Goal");
  });

  it("falls back to the scraped heading when the column is null", async () => {
    const {
      formatPlanChecklistForPrompt,
      parsePlanChecklist,
      extractPlanChecklistTitle,
    } = await import("@/lib/tasks/plan-checklist");
    const content = "# Add auth\n\n1. [ ] Create login form";
    const stored: string | null = null;

    const line = formatPlanChecklistForPrompt(
      parsePlanChecklist(content),
      stored ?? extractPlanChecklistTitle(content),
    )!;

    expect(line).toContain("Add auth");
  });
});
