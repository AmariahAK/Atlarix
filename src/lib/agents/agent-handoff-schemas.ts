/**
 * v5.1 Section 5b: Structured handoff payloads between delegated agents (Zod).
 * Used for validation and future ContextAssembler / UI cards.
 */

import { z } from "zod";

export const ArchitectPlanPayloadSchema = z.object({
  version: z.literal(1),
  summary: z.string(),
  phases: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      tasks: z.array(z.string()),
    }),
  ),
  risks: z.array(z.string()).optional(),
});

export type ArchitectPlanPayload = z.infer<typeof ArchitectPlanPayloadSchema>;

export const BuilderExecutionSummarySchema = z.object({
  version: z.literal(1),
  filesTouched: z.array(z.string()),
  summary: z.string(),
  testsRun: z.string().optional(),
});

export type BuilderExecutionSummary = z.infer<typeof BuilderExecutionSummarySchema>;

export const ReviewerFindingsSchema = z.object({
  version: z.literal(1),
  severity: z.enum(["pass", "minor", "major", "blocker"]),
  findings: z.array(
    z.object({
      file: z.string().optional(),
      message: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
});

export type ReviewerFindings = z.infer<typeof ReviewerFindingsSchema>;

export const DebuggerRootCauseSchema = z.object({
  version: z.literal(1),
  hypothesis: z.string(),
  likelyFiles: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

export type DebuggerRootCause = z.infer<typeof DebuggerRootCauseSchema>;
