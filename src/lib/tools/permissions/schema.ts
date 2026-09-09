/**
 * Permission Schema
 * =================
 * Zod schemas for structured JSON permission requests.
 * Used by write tools to request user approval before file operations.
 */

import { z } from "zod";

// ════════════════════════════════════════════════════════════════════════════
// FILE OPERATION PREVIEW
// ════════════════════════════════════════════════════════════════════════════

export const FileOperationPreviewSchema = z.object({
  path: z.string().describe("File path relative to workspace"),
  content: z.string().optional().describe("File content for create/update"),
  oldContent: z.string().optional().describe("Original content for edits"),
  description: z.string().describe("What this operation does"),
  type: z.enum(["create", "update", "delete", "rename"]),
  lines: z.number().optional().describe("Number of lines in content"),
  diff: z.string().optional().describe("Unified diff format"),
  notice: z
    .string()
    .optional()
    .describe(
      "Audit note surfaced to the model and activity card (e.g. fuzzy-match indent/EOL drift)",
    ),
  // Set at execute time: did the on-disk bytes match what we intended to
  // write? Stashed here so the (sync) getExecutionResult can report it. Used
  // by the end-of-turn self-review gate; never sent to the model on success.
  verified: z.boolean().optional(),
  // For rename operations
  fromPath: z.string().optional().describe("Original path (for rename)"),
  toPath: z.string().optional().describe("New path (for rename)"),
  isProtectedFile: z.boolean().optional(),
  isDeleteOrRename: z.boolean().optional(),
  canAlwaysAllowFile: z.boolean().optional(),
  canAlwaysAllowDirectory: z.boolean().optional(),
  canAlwaysAllowExtension: z.boolean().optional(),
  fileParentDir: z.string().optional(),
  fileExtension: z.string().optional(),
});

export type FileOperationPreview = z.infer<typeof FileOperationPreviewSchema>;

// ════════════════════════════════════════════════════════════════════════════
// COMMAND OPERATION PREVIEW
// ════════════════════════════════════════════════════════════════════════════

export const CommandOperationPreviewSchema = z.object({
  command: z.string().describe("Command to execute"),
  workingDirectory: z.string().optional().describe("Working directory"),
  description: z.string().describe("What this command does"),
  isDangerous: z.boolean().optional().describe("Whether command is risky"),
  dangerExplanation: z
    .string()
    .optional()
    .describe("Plain-English explanation of risks"),
  commandCategory: z
    .string()
    .optional()
    .describe("First token category for workspace terminal rules"),
  canAlwaysAllow: z
    .boolean()
    .optional()
    .describe("Whether Always allow category is offered"),
  /** Changes something OUTSIDE the project (on-device install, sudo, outside-workspace write). */
  systemScope: z
    .boolean()
    .optional()
    .describe("Whether command changes the system outside the project"),
  systemScopeExplanation: z
    .string()
    .optional()
    .describe("Plain-English 'what it touches outside the project'"),
  /** Set by the branch runner when a HUMAN interactively approved this system-scope command
   *  (attended only) — lets the interceptor run it unsandboxed / widen writable roots. */
  systemScopeInteractive: z.boolean().optional(),
  /** Max wall-clock for the shell run (ms). Clamped in the interceptor. */
  timeout_ms: z.number().optional(),
  /** Max UTF-8 bytes for formatted output returned to the model. */
  max_output_bytes: z.number().optional(),
  /** Set by main when user checked "I understand" for dangerous commands. */
  danger_acknowledged: z.boolean().optional(),
  /**
   * Force the READ-ONLY sandbox profile for this one command, regardless of the
   * turn's work mode.
   *
   * The sandbox's read-only-ness is otherwise a property of the TURN
   * (`turnWorkMode`), which is right for the main agent and wrong for a QA
   * sub-agent: it borrows the parent turn's interceptor, so on a Build turn it
   * would inherit workspace-write — the opposite of a worker whose job is to
   * observe. Writes stay denied by the OS while caches, /tmp and the network
   * stay available, which is exactly the QA profile.
   *
   * Narrowing only. There is deliberately no way to REQUEST write access here;
   * a preview cannot widen what the turn's mode allows.
   */
  readOnly: z.boolean().optional(),
  /**
   * Which sub-agent asked, when the request came from a worker rather than the
   * main agent. Rendered as a chip on the approval card — an unlabelled ask
   * from a worker the user did not know was running is worse than no ask.
   */
  requestedByAgent: z.string().optional(),
});

export type CommandOperationPreview = z.infer<
  typeof CommandOperationPreviewSchema
>;

// ════════════════════════════════════════════════════════════════════════════
// SANDBOX ESCALATION PREVIEW (escalation-on-denial)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Raised mid-run when a sandboxed command was DENIED a write to a path outside
 * the writable set (e.g. an unlisted toolchain's cache). Approving grants the
 * command sandbox write access to `grantPath` for this workspace and retries the
 * command — still sandboxed. See PermissionInterceptor.maybeEscalateSandboxDenial.
 */
export const SandboxEscalationPreviewSchema = z.object({
  /**
   * Which lane asked. Both grant the SAME folder record — a directory the user
   * allows Atlarix to write in for this workspace — so the two lanes can never
   * disagree again; only the card's wording differs.
   */
  kind: z.enum(["command", "file"]).optional().default("command"),
  command: z
    .string()
    .optional()
    .describe("The command that was denied a write by the sandbox"),
  deniedPath: z.string().describe("The exact path a write was denied to"),
  grantPath: z.string().describe("The folder granted write access on approval"),
  description: z.string().describe("Human-readable summary of the denial"),
  workingDirectory: z.string().optional(),
  /** Set for file grants so unattended runs hard-deny (see auto-approve paths). */
  systemScope: z.boolean().optional(),
});

export type SandboxEscalationPreview = z.infer<
  typeof SandboxEscalationPreviewSchema
>;

export const WorkforceActionPreviewSchema = z.object({
  service: z
    .string()
    .describe("Target connector service (e.g. slack, jira, gitlab)"),
  action: z.string().describe("Action name to execute"),
  description: z.string().describe("Human-readable summary of the action"),
  payload: z
    .record(z.string(), z.unknown())
    .describe("Action payload arguments"),
});

/**
 * Creating / changing / deleting an automation.
 *
 * Gated for a reason the file-write gate does not cover: this is a STANDING
 * order. An approved file write happens once and leaves a diff to notice; an
 * approved automation runs on a schedule, unattended, possibly spending tokens,
 * until someone remembers it exists — and a deleted one leaves nothing on disk
 * to notice at all.
 *
 * The card carries `runMode` and `notifyAgent` explicitly because between them
 * they decide whether this costs money while nobody is watching, and that must
 * not be something the user has to infer from a name.
 */
export const AutomationOperationPreviewSchema = z.object({
  action: z.enum(["create", "update", "delete"]),
  name: z.string(),
  /** Human-readable trigger ("every weekday at 09:00", "CI failures on owner/repo"). */
  triggerSummary: z.string(),
  description: z.string(),
  /** Present for create/update; absent for delete. */
  runMode: z.enum(["notify-only", "read-only"]).optional(),
  notifyAgent: z.boolean().optional(),
  /**
   * Which automation this operation concerns.
   *
   * Set UP FRONT for update/delete. For create it is filled in at EXECUTE time
   * by `executeAutomationWrite`, because the id does not exist until after the
   * user approves — the same stash-on-the-preview trick `verified` uses below,
   * so the (sync) `getExecutionResult` can hand it back to the model. Without
   * it the model cannot `operation:"run"` the automation it just created, which
   * is exactly what the tool description tells it to do next.
   */
  automationId: z.string().optional(),
  /** update only: a short "was → now" per changed field, so the card shows the delta. */
  changes: z.array(z.string()).optional(),
  /** Set when an MCP trigger will record standing consent for its tool. */
  grantsMcpConsent: z.string().optional(),
  /**
   * The validated `AutomationInput` to apply on approval (create/update).
   *
   * Carried INSIDE the preview rather than beside it because the request is
   * zod-parsed on its way through, and `z.object` strips unknown keys — a
   * sibling field would have been silently dropped and the executor would have
   * approved an automation it then had no payload to write.
   */
  input: z.unknown().optional(),
});

export type AutomationOperationPreview = z.infer<
  typeof AutomationOperationPreviewSchema
>;

export const ProjectRevertPreviewSchema = z.object({
  snapshotId: z.coerce.number().int().positive(),
  label: z.string(),
  planExcerpt: z.string().max(800).optional(),
});

// ════════════════════════════════════════════════════════════════════════════
// PERMISSION REQUEST (Main Schema)
// ════════════════════════════════════════════════════════════════════════════

export const PermissionOperationType = z.enum([
  // No "write_file", "replace_code", "insert_code", "delete_lines",
  // "edit_file_section" or "batch_refactor": every file mutation has gone through
  // `edit_file` since v13.8, and none of these has a producer any more (measured:
  // `edit_file` is emitted at 26 live sites, each of these at zero). Their DISPLAY
  // entries live on in tool-activity-labels / tool-expand-view /
  // stream-tool-display, because sessions persisted before v13.8 still contain
  // tool calls under those names and must keep rendering.
  // No "write_multiple_files": every mutation goes through `edit_file`, and the
  // batch permission path it fed was reachable only from itself (v14.36.0
  // removal). Its DISPLAY entries live on in tool-activity-labels /
  // tool-expand-view / stream-tool-display, because sessions persisted before
  // the removal still render cards under that name.
  "delete_file",
  "rename_file",
  "run_command",
  // Parent-aggregated: one approval for a full plan (v2.2)
  "batch_plan",
  // Surgical edit tools (unified edit_file + legacy names)
  "edit_file",
  // Restore plan from SQLite snapshot (v5.0 project memory)
  "revert_project_snapshot",
  // Sandbox write-denial escalation (grant a denied path + retry sandboxed)
  "sandbox_escalation",
  // Create/update/delete a standing automation (v14.27.0)
  "automation_write",
]);

/** Single operation inside a batch_plan (file or command) */
export const BatchPlanItemSchema = z.union([
  FileOperationPreviewSchema,
  CommandOperationPreviewSchema,
]);

/** Preview for batch_plan: title + list of operations */
export const BatchPlanPreviewSchema = z.object({
  title: z
    .string()
    .describe("Short title for the plan (e.g. 'Building auth system')"),
  summary: z
    .string()
    .optional()
    .describe("One-line summary (e.g. '3 files to create, 1 to modify')"),
  operations: z
    .array(BatchPlanItemSchema)
    .describe("Ordered list of file or command operations"),
});
export type BatchPlanPreview = z.infer<typeof BatchPlanPreviewSchema>;

export type PermissionOperationType = z.infer<typeof PermissionOperationType>;

export const PermissionRequestSchema = z.object({
  __permission_required: z.literal(true),
  operation: PermissionOperationType,
  preview: z.union([
    FileOperationPreviewSchema,
    z.array(FileOperationPreviewSchema),
    CommandOperationPreviewSchema,
    SandboxEscalationPreviewSchema,
    AutomationOperationPreviewSchema,
    WorkforceActionPreviewSchema,
    BatchPlanPreviewSchema,
    ProjectRevertPreviewSchema,
  ]),
});

export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

// ════════════════════════════════════════════════════════════════════════════
// PERMISSION RESULT
// ════════════════════════════════════════════════════════════════════════════

export const PermissionResultSchema = z.object({
  operationId: z.string(),
  approved: z.boolean(),
  executedAt: z.number().optional(),
  error: z.string().optional(),
});

export type PermissionResult = z.infer<typeof PermissionResultSchema>;

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse JSON string to permission request
 */
export function parsePermissionRequest(json: string): PermissionRequest | null {
  try {
    const parsed = JSON.parse(json);
    return PermissionRequestSchema.parse(parsed);
  } catch {
    return null;
  }
}
