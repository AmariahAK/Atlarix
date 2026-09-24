import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  addOperation,
  getOperationsByStatus,
  permissionQueueAtom,
  removeOperation,
  updateOperationStatus,
  type QueuedOperation,
} from "@/atoms/permissionQueueAtom";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { SmartDiffView } from "@/components/SmartDiffView";
import { composeContentFromHunks } from "@/lib/diff/compose-hunks";
import { Clock, Plug, Shield, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** v10 per-hunk approval: latest hunk selection per pending operation. */
type HunkSelection = { selected: number[]; total: number };

const FILE_OPERATIONS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "rename_file",
  "batch_plan",
  "batch_refactor",
  "replace_code",
  "insert_code",
  "delete_lines",
]);

function isFileOperation(op: QueuedOperation["operation"]): boolean {
  return FILE_OPERATIONS.has(op);
}

function queueEntryFromPermission(
  operationId: string,
  request: { operation: string; preview: unknown },
): Omit<QueuedOperation, "timestamp"> {
  const preview = request.preview as Record<string, unknown>;

  // There is no multi-file branch here any more. `write_multiple_files` carried an
  // ARRAY preview, and this function took `files[0]` for path/content — so the
  // card rendered ONE file's diff while approving wrote all of them, and
  // `permissions/handlers.ts` read `.path` off the array, got `undefined`, and
  // saved no rule at all: "Always allow this file" was a no-op that looked like
  // it worked. It was also unreachable (no tool has emitted that operation since
  // write_file folded into edit_file), which is why it could be deleted rather
  // than repaired.
  //
  // The invariant it violated still applies to every card below: an "always"
  // option must describe exactly what the grant covers, and must be WITHHELD
  // when the contents cannot be fully shown.
  return {
    id: operationId,
    operation: (request.operation as QueuedOperation["operation"]) || "unknown",
    command: preview.command as string | undefined,
    path: preview.path as string | undefined,
    content: preview.content as string | undefined,
    oldContent: preview.oldContent as string | undefined,
    description: preview.description as string | undefined,
    preview: JSON.stringify(request.preview, null, 2).slice(0, 800),
    status: "pending",
    isDangerous: preview.isDangerous as boolean | undefined,
    dangerExplanation: preview.dangerExplanation as string | undefined,
    systemScope: preview.systemScope as boolean | undefined,
    systemScopeExplanation: preview.systemScopeExplanation as
      | string
      | undefined,
    commandCategory: preview.commandCategory as string | undefined,
    canAlwaysAllow: preview.canAlwaysAllow as boolean | undefined,
    isProtectedFile: preview.isProtectedFile as boolean | undefined,
    isDeleteOrRename: preview.isDeleteOrRename as boolean | undefined,
    canAlwaysAllowFile: preview.canAlwaysAllowFile as boolean | undefined,
    canAlwaysAllowDirectory: preview.canAlwaysAllowDirectory as
      | boolean
      | undefined,
    canAlwaysAllowExtension: preview.canAlwaysAllowExtension as
      | boolean
      | undefined,
    fileParentDir: preview.fileParentDir as string | undefined,
    fileExtension: preview.fileExtension as string | undefined,
    sandboxDeniedPath: preview.deniedPath as string | undefined,
    sandboxGrantPath: preview.grantPath as string | undefined,
    sandboxGrantKind: preview.kind as "command" | "file" | undefined,
    ...(request.operation === "automation_write" && {
      automationAction: preview.action as
        | "create"
        | "update"
        | "delete"
        | undefined,
      automationName: preview.name as string | undefined,
      automationTrigger: preview.triggerSummary as string | undefined,
      automationRunMode: preview.runMode as
        | "notify-only"
        | "read-only"
        | undefined,
      automationNotifyAgent: preview.notifyAgent as boolean | undefined,
      automationChanges: preview.changes as string[] | undefined,
      automationGrantsMcpConsent: preview.grantsMcpConsent as
        | string
        | undefined,
    }),
    ...(request.operation === "mcp_server_write" && {
      mcpAction: preview.action as "add" | "edit" | "delete" | undefined,
      mcpServerName: preview.serverName as string | undefined,
      mcpTransport: preview.transport as "stdio" | "http" | undefined,
      mcpCommand: preview.command as string | undefined,
      mcpArgs: preview.args as string[] | undefined,
      mcpUrl: preview.url as string | undefined,
      mcpEnvKeys: preview.envKeys as string[] | undefined,
      mcpChanges: preview.changes as string[] | undefined,
    }),
    ...(request.operation === "batch_plan" && {
      batchPlanTitle: preview.title as string | undefined,
      batchPlanSummary: preview.summary as string | undefined,
      batchPlanOperationsCount: Array.isArray(preview.operations)
        ? preview.operations.length
        : 0,
    }),
  };
}

function FilePermissionCard({
  operation,
  appId,
  onOnce,
  onAlwaysFile,
  onAlwaysDirectory,
  onAlwaysExtension,
  onDeny,
  onHunkSelectionChange,
  hunkSelection,
}: {
  operation: QueuedOperation;
  appId: number | null;
  onOnce: (id: string) => void;
  onAlwaysFile: (id: string) => void;
  onAlwaysDirectory: (id: string) => void;
  onAlwaysExtension: (id: string) => void;
  onDeny: (id: string) => void;
  onHunkSelectionChange?: (
    id: string,
    selected: number[],
    total: number,
  ) => void;
  hunkSelection?: HunkSelection;
}) {
  const title =
    operation.description?.trim() ||
    operation.path?.trim() ||
    operation.operation.replace(/_/g, " ");

  // `isProtectedFile` now only ever means "the path was empty/malformed" — the hardcoded
  // protected-path list was removed in v14.23.0 (it made `.github/workflows/*.yml` a dead
  // end: prompt forever, no always-allow offered). Still honoured for the degenerate case,
  // but there is no longer a "Protected path" notice to render, because no ordinary file is
  // protected any more.
  const isProtected = Boolean(operation.isProtectedFile);
  const isDeleteOrRename =
    Boolean(operation.isDeleteOrRename) ||
    operation.operation === "delete_file" ||
    operation.operation === "rename_file";
  const parentDir = operation.fileParentDir?.trim();
  const extension = operation.fileExtension?.trim();
  const showScopedAlways =
    !isProtected &&
    !isDeleteOrRename &&
    appId != null &&
    (operation.canAlwaysAllowFile !== false ||
      operation.canAlwaysAllowDirectory !== false ||
      operation.canAlwaysAllowExtension !== false);

  return (
    <div className="my-2 rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
        <Shield className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground/90 truncate">
          {title}
        </span>
      </div>
      {isDeleteOrRename ? (
        <p className="px-3 py-2 text-[11px] text-amber-900 dark:text-amber-100/90">
          This change removes or renames a file. Directory and extension rules
          never auto-approve deletes — use Allow once to proceed.
        </p>
      ) : null}
      <div className="px-2 pb-2">
        {operation.path && operation.content != null && !isDeleteOrRename ? (
          <SmartDiffView
            path={operation.path}
            oldContent={operation.oldContent ?? ""}
            newContent={operation.content}
            description={operation.description}
            // A create (no prior content) renders as all-added; an overwrite/edit
            // diffs against the prior content. Inferred so we needn't plumb the
            // preview's create/update type all the way here.
            operation={operation.oldContent ? "update" : "create"}
            maxHeight="max-h-56"
            selectable
            onHunkSelectionChange={
              onHunkSelectionChange
                ? (selected, total) =>
                    onHunkSelectionChange(operation.id, selected, total)
                : undefined
            }
          />
        ) : operation.content ? (
          <pre className="text-[11px] bg-[var(--diff-add-bg,theme(colors.emerald.500/10))] text-foreground/80 p-2 rounded overflow-x-auto max-h-40">
            {operation.content.split("\n").slice(0, 24).join("\n")}
          </pre>
        ) : operation.preview ? (
          <pre className="text-[11px] text-muted-foreground p-2 overflow-x-auto max-h-32">
            {operation.preview}
          </pre>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2 px-3 pb-2">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onOnce(operation.id)}
        >
          {hunkSelection && hunkSelection.selected.length < hunkSelection.total
            ? `Apply ${hunkSelection.selected.length}/${hunkSelection.total} hunks`
            : "Allow once"}
        </Button>
        {showScopedAlways &&
        operation.canAlwaysAllowFile !== false &&
        operation.path ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => onAlwaysFile(operation.id)}
          >
            Always allow this file
          </Button>
        ) : null}
        {showScopedAlways &&
        operation.canAlwaysAllowDirectory !== false &&
        parentDir ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => onAlwaysDirectory(operation.id)}
          >
            Always allow {parentDir}/**
          </Button>
        ) : null}
        {showScopedAlways &&
        operation.canAlwaysAllowExtension !== false &&
        extension ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => onAlwaysExtension(operation.id)}
          >
            Always allow {extension}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => onDeny(operation.id)}
        >
          Deny
        </Button>
      </div>
      {showScopedAlways ? (
        <p className="px-3 pb-2 text-[10px] text-muted-foreground/80">
          “Always allow” saves a workspace rule and skips the approval pause for
          matching edits from then on.
        </p>
      ) : null}
    </div>
  );
}

function CommandPermissionCard({
  operation,
  appId,
  onOnce,
  onAlways,
  onDeny,
}: {
  operation: QueuedOperation;
  appId: number | null;
  onOnce: (id: string) => void;
  onAlways: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const isDangerous = Boolean(operation.isDangerous);
  const systemScope = Boolean(operation.systemScope);
  // Dangerous commands are now always-allowable too — the amber styling is an
  // informational badge, not a blocking gate. Only a resolved rule (backend
  // sets canAlwaysAllow=false) hides the button.
  const canAlwaysAllow = operation.canAlwaysAllow !== false;
  const category = operation.commandCategory ?? "command";
  // For a dangerous command the category is a `danger:<id>` key; show a friendly
  // rule label instead of the raw key.
  const isDangerKey = category.startsWith("danger:");
  const alwaysAllowLabel = isDangerKey ? "this command" : category;

  return (
    <div
      className={cn(
        "my-2 rounded-lg border px-3 py-2 text-xs",
        isDangerous
          ? "border-amber-500/40 bg-amber-500/10"
          : systemScope
            ? "border-sky-500/40 bg-sky-500/10"
            : "border-border/60 bg-muted/20",
      )}
    >
      <div className="flex items-start gap-2">
        <Terminal className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 font-medium text-foreground/90">
            Run command
            {isDangerous ? (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                Dangerous
              </span>
            ) : null}
            {systemScope ? (
              <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-900 dark:text-sky-200">
                System change
              </span>
            ) : null}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground break-all bg-background/60 rounded px-2 py-1.5">
            $ {operation.command}
          </div>
          {isDangerous && operation.dangerExplanation ? (
            <p className="mt-1.5 text-amber-900 dark:text-amber-100/90">
              {operation.dangerExplanation}
            </p>
          ) : null}
          {!isDangerous && systemScope ? (
            <p className="mt-1.5 text-sky-900 dark:text-sky-100/90">
              {operation.systemScopeExplanation ??
                "This changes something outside the current project."}{" "}
              It runs outside the project sandbox — only allow if you expect it.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onOnce(operation.id)}
        >
          Allow once
        </Button>
        {canAlwaysAllow ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            disabled={appId == null}
            title={
              appId == null ? "Select a workspace to save rules" : undefined
            }
            onClick={() => onAlways(operation.id)}
          >
            Always allow {alwaysAllowLabel}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => onDeny(operation.id)}
        >
          Deny
        </Button>
      </div>
      {canAlwaysAllow ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground/80">
          {isDangerKey ? (
            <>
              “Always allow” saves a workspace rule for this specific command
              and skips the approval pause for it from then on. You can revoke
              it in Settings.
            </>
          ) : (
            <>
              “Always allow” saves a workspace rule for the{" "}
              <span className="font-mono">{category}</span> category and skips
              the approval pause for it from then on.
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Approving an MCP server add / edit / delete.
 *
 * The card exists to make ONE thing legible: for a `stdio` server, approving means
 * Atlarix will launch that program, with that argv, on this machine, every time a tool
 * on it is called. So the command renders LITERALLY and in monospace rather than as a
 * friendly summary — the name and description are the parts an attacker controls, and
 * the realistic source of this proposal is a config file in a repo the agent just
 * cloned.
 *
 * Env variable NAMES only, never values: a value belongs in the store, not on a card
 * that is also written to the permission log.
 *
 * No "always allow" — same as the automation card. There is no version of "approve
 * every future MCP server" that is safe to offer.
 */
export function McpServerPermissionCard({
  operation,
  onAllow,
  onDeny,
}: {
  operation: QueuedOperation;
  onAllow: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const action = operation.mcpAction ?? "edit";
  const verb =
    action === "add" ? "Add" : action === "delete" ? "Remove" : "Update";
  const isStdio = operation.mcpTransport === "stdio";
  const runsAProgram = isStdio && action !== "delete";
  return (
    <div className="my-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Plug className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 font-medium text-foreground/90">
            {verb} MCP server
            {runsAProgram ? (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                Runs a program
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-amber-900 dark:text-amber-100/90">
            <span className="font-medium">{operation.mcpServerName}</span>
          </p>

          {runsAProgram ? (
            <p className="mt-1.5 text-[11px] text-amber-900/90 dark:text-amber-100/80">
              Atlarix will run this on your machine whenever one of its tools is
              used:
            </p>
          ) : null}

          {/* Verbatim, monospace, never summarised — this is the thing being approved. */}
          {operation.mcpCommand ? (
            <div className="mt-1 font-mono text-[11px] break-all bg-background/60 rounded px-2 py-1.5">
              {[operation.mcpCommand, ...(operation.mcpArgs ?? [])].join(" ")}
            </div>
          ) : null}
          {operation.mcpUrl ? (
            <div className="mt-1 font-mono text-[11px] break-all bg-background/60 rounded px-2 py-1.5">
              {operation.mcpUrl}
            </div>
          ) : null}

          {operation.mcpEnvKeys?.length ? (
            <p className="mt-1.5 text-[11px] text-amber-900/90 dark:text-amber-100/80">
              With environment variables:{" "}
              <span className="font-mono">
                {operation.mcpEnvKeys.join(", ")}
              </span>
            </p>
          ) : null}

          {action === "delete" ? (
            <p className="mt-1.5 text-[11px] text-amber-900/90 dark:text-amber-100/80">
              Its stored tool approvals are removed with it.
            </p>
          ) : null}

          {operation.mcpChanges?.length ? (
            <div className="mt-2 font-mono text-[11px] text-muted-foreground bg-background/60 rounded px-2 py-1.5 space-y-0.5">
              {operation.mcpChanges.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
          ) : null}

          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => onAllow(operation.id)}
            >
              {verb}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onDeny(operation.id)}
            >
              Decline
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Approving a standing automation.
 *
 * Deliberately spells out `notifyAgent` and `runMode` rather than leaving them
 * to the name. Between them they decide whether this costs money while nobody is
 * watching, and that is not something a user should have to infer from
 * "CI failures on main" — it is the single fact this card exists to surface.
 */
export function AutomationPermissionCard({
  operation,
  onAllow,
  onDeny,
}: {
  operation: QueuedOperation;
  onAllow: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const action = operation.automationAction ?? "update";
  const isDelete = action === "delete";
  const verb = isDelete ? "Delete" : action === "create" ? "Create" : "Update";
  const notifies = operation.automationNotifyAgent === true;
  const runsAgent = operation.automationRunMode === "read-only";
  return (
    <div className="my-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Clock className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 font-medium text-foreground/90">
            {verb} automation
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
              Runs on its own
            </span>
          </div>
          <p className="mt-1.5 text-amber-900 dark:text-amber-100/90">
            <span className="font-medium">{operation.automationName}</span>
            {operation.automationTrigger ? (
              <> — {operation.automationTrigger}</>
            ) : null}
          </p>

          {!isDelete && (
            <ul className="mt-2 space-y-1 text-[11px] text-amber-900/90 dark:text-amber-100/80">
              <li>
                {notifies
                  ? "Tells the AI when it finishes, so it can act on the result."
                  : "Tells you only — the AI is never woken, so this can't spend tokens."}
              </li>
              <li>
                {runsAgent
                  ? "Runs an unattended AI turn each time it fires (costs one turn per fire)."
                  : "Posts the event with no AI turn."}
              </li>
              {operation.automationGrantsMcpConsent ? (
                <li>
                  Grants standing consent to the MCP tool{" "}
                  <span className="font-mono">
                    {operation.automationGrantsMcpConsent}
                  </span>{" "}
                  (the poller runs unattended and can't ask).
                </li>
              ) : null}
            </ul>
          )}

          {operation.automationChanges?.length ? (
            <div className="mt-2 font-mono text-[11px] text-muted-foreground bg-background/60 rounded px-2 py-1.5 space-y-0.5">
              {operation.automationChanges.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
          ) : null}

          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => onAllow(operation.id)}
            >
              {verb}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onDeny(operation.id)}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SandboxEscalationCard({
  operation,
  onAllow,
  onDeny,
}: {
  operation: QueuedOperation;
  onAllow: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  // Both lanes grant the SAME record — a folder this workspace may write in — so
  // only the wording differs. A command was blocked by the sandbox; a file edit
  // targeted somewhere outside the project.
  const isFileGrant = operation.sandboxGrantKind === "file";
  return (
    <div className="my-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Shield className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 font-medium text-foreground/90">
            {isFileGrant
              ? "Grant write access to a folder"
              : "Sandbox: grant write access"}
            <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-900 dark:text-sky-200">
              {isFileGrant ? "Outside workspace" : "Blocked write"}
            </span>
          </div>
          <p className="mt-1.5 text-sky-900 dark:text-sky-100/90">
            {isFileGrant ? (
              <>
                <span className="font-mono break-all">
                  {operation.sandboxDeniedPath}
                </span>{" "}
                is outside this workspace. Allow Atlarix to write in{" "}
                <span className="font-mono break-all">
                  {operation.sandboxGrantPath}
                </span>{" "}
                for this workspace?
              </>
            ) : (
              <>
                The command sandbox blocked a write to{" "}
                <span className="font-mono break-all">
                  {operation.sandboxDeniedPath}
                </span>
                . Allow it write access to{" "}
                <span className="font-mono break-all">
                  {operation.sandboxGrantPath}
                </span>{" "}
                for this workspace and retry?
              </>
            )}
          </p>
          {operation.command ? (
            <div className="mt-1 font-mono text-[11px] text-muted-foreground break-all bg-background/60 rounded px-2 py-1.5">
              $ {operation.command}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAllow(operation.id)}
        >
          {isFileGrant ? "Allow folder" : "Allow & retry"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => onDeny(operation.id)}
        >
          Deny
        </Button>
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground/80">
        “Allow” saves a workspace rule letting Atlarix write in this folder —
        both file edits and sandboxed commands
        {isFileGrant ? "" : ", and re-runs the command still sandboxed"}. Every
        individual change still asks. Revoke it any time in Settings → Workflow.
      </p>
    </div>
  );
}

/** Inline permission approvals with diffs and workspace terminal categories. */
export function InlinePermissionApprovals({ chatId }: { chatId: number }) {
  const queue = useAtomValue(permissionQueueAtom);
  const setQueue = useSetAtom(permissionQueueAtom);
  const appId = useAtomValue(selectedAppIdAtom);
  const loadedForChatRef = useRef<number | null>(null);
  // v10 per-hunk approval: latest hunk selection per operation id.
  const [hunkSelections, setHunkSelections] = useState<
    Record<string, HunkSelection>
  >({});

  const handleHunkSelectionChange = useCallback(
    (id: string, selected: number[], total: number) => {
      setHunkSelections((prev) => {
        const existing = prev[id];
        if (
          existing &&
          existing.total === total &&
          existing.selected.length === selected.length &&
          existing.selected.every((v, i) => v === selected[i])
        ) {
          return prev;
        }
        return { ...prev, [id]: { selected, total } };
      });
    },
    [],
  );

  useEffect(() => {
    if (loadedForChatRef.current === chatId) return;
    loadedForChatRef.current = chatId;

    const loadPermissions = async () => {
      try {
        const pending = await IpcClient.getInstance().getPendingPermissions({
          chatId,
        });
        pending.forEach((p) => {
          setQueue((q) => {
            if (q.has(p.id)) return q;
            return addOperation(q, queueEntryFromPermission(p.id, p.request));
          });
        });
      } catch {
        /* ignore */
      }
    };
    void loadPermissions();

    const unsubscribe = IpcClient.getInstance().onPermissionRequest(
      chatId,
      (payload) => {
        setQueue((q) => {
          if (q.has(payload.operationId)) return q;
          return addOperation(
            q,
            queueEntryFromPermission(payload.operationId, payload.request),
          );
        });
      },
    );

    const blockedUnsub = IpcClient.getInstance().onCommandPermissionBlocked(
      chatId,
      (payload) => {
        toast.error(payload.message ?? "Command blocked");
      },
    );

    const fileBlockedUnsub = IpcClient.getInstance().onFilePermissionBlocked(
      chatId,
      (payload) => {
        toast.error(payload.message ?? "File edit blocked");
      },
    );

    return () => {
      if (loadedForChatRef.current === chatId) loadedForChatRef.current = null;
      unsubscribe();
      blockedUnsub?.();
      fileBlockedUnsub?.();
    };
  }, [chatId, setQueue]);

  const pending = getOperationsByStatus(queue, "pending");
  const filePending = useMemo(
    () => pending.filter((op) => isFileOperation(op.operation)),
    [pending],
  );
  const commandPending = useMemo(
    () => pending.filter((op) => op.operation === "run_command"),
    [pending],
  );
  const escalationPending = useMemo(
    () => pending.filter((op) => op.operation === "sandbox_escalation"),
    [pending],
  );
  const automationPending = useMemo(
    () => pending.filter((op) => op.operation === "automation_write"),
    [pending],
  );
  const mcpServerPending = useMemo(
    () => pending.filter((op) => op.operation === "mcp_server_write"),
    [pending],
  );
  const otherPending = useMemo(
    () =>
      pending.filter(
        (op) =>
          !isFileOperation(op.operation) &&
          op.operation !== "run_command" &&
          op.operation !== "sandbox_escalation" &&
          op.operation !== "automation_write" &&
          op.operation !== "mcp_server_write",
      ),
    [pending],
  );

  const runFileApproval = useCallback(
    async (
      id: string,
      approvalMode:
        | "once"
        | "always_allow_file"
        | "always_allow_directory"
        | "always_allow_extension"
        | "deny",
    ) => {
      // v10 per-hunk approval: compose partial content when hunks were deselected.
      let overrideContent: string | undefined;
      const selection = hunkSelections[id];
      if (
        approvalMode !== "deny" &&
        selection &&
        selection.total > 1 &&
        selection.selected.length < selection.total
      ) {
        const op = queue.get(id);
        if (op?.content != null && op.oldContent !== undefined) {
          overrideContent = composeContentFromHunks(
            op.oldContent,
            op.content,
            selection.selected,
          );
        }
      }
      setQueue((q) => updateOperationStatus(q, id, { status: "queued" }));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode,
        appId:
          approvalMode === "once" || approvalMode === "deny"
            ? undefined
            : (appId ?? undefined),
        overrideContent,
      });
    },
    [chatId, setQueue, appId, hunkSelections, queue],
  );

  const handleFileOnce = useCallback(
    (id: string) => void runFileApproval(id, "once"),
    [runFileApproval],
  );

  const handleFileAlwaysFile = useCallback(
    (id: string) => void runFileApproval(id, "always_allow_file"),
    [runFileApproval],
  );

  const handleFileAlwaysDirectory = useCallback(
    (id: string) => void runFileApproval(id, "always_allow_directory"),
    [runFileApproval],
  );

  const handleFileAlwaysExtension = useCallback(
    (id: string) => void runFileApproval(id, "always_allow_extension"),
    [runFileApproval],
  );

  const handleFileDeny = useCallback(
    async (id: string) => {
      setQueue((q) => removeOperation(q, id));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "deny",
      });
    },
    [chatId, setQueue],
  );

  const handleCommandOnce = useCallback(
    async (id: string) => {
      setQueue((q) => updateOperationStatus(q, id, { status: "queued" }));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "once",
      });
    },
    [chatId, setQueue],
  );

  const handleCommandAlways = useCallback(
    async (id: string) => {
      setQueue((q) => updateOperationStatus(q, id, { status: "queued" }));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "always_allow",
        appId: appId ?? undefined,
      });
    },
    [chatId, setQueue, appId],
  );

  const handleCommandDeny = useCallback(
    async (id: string) => {
      setQueue((q) => removeOperation(q, id));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "deny",
      });
    },
    [chatId, setQueue],
  );

  // Sandbox escalation: "Allow" resolves the approval (approved) — the interceptor
  // persists the workspace grant and re-runs the command still sandboxed. No appId
  // needed (the interceptor uses its own workspaceId).
  /** Plain allow/deny, shared by sandbox escalations and automation writes —
   *  neither offers per-file/per-directory scopes, so "once" is the only mode. */
  const handleSimpleAllow = useCallback(
    async (id: string) => {
      setQueue((q) => updateOperationStatus(q, id, { status: "queued" }));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "once",
      });
    },
    [chatId, setQueue],
  );

  const handleSimpleDeny = useCallback(
    async (id: string) => {
      setQueue((q) => removeOperation(q, id));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "deny",
      });
    },
    [chatId, setQueue],
  );

  const handleApproveAllFiles = useCallback(async () => {
    for (const op of filePending) {
      await handleFileOnce(op.id);
    }
  }, [filePending, handleFileOnce]);

  const handleRejectAllFiles = useCallback(async () => {
    for (const op of filePending) {
      await handleFileDeny(op.id);
    }
  }, [filePending, handleFileDeny]);

  if (!pending.length) return null;

  return (
    // Scroll anchor for `PendingApprovalsBar`'s "Review". The bar lives above the
    // composer because a card scrolls out of view on a long turn; this is how it
    // brings you back to the diffs, which stay here where the record belongs.
    <div className="space-y-0" data-permission-approvals={chatId}>
      {filePending.length >= 2 ? (
        <div className="my-2 flex flex-wrap gap-2 rounded-lg border border-border/50 bg-muted/15 px-3 py-2">
          <span className="text-xs text-muted-foreground w-full">
            {filePending.length} file changes awaiting approval
            {(() => {
              // v10: running hunk summary across the pending change set.
              const tracked = filePending
                .map((op) => hunkSelections[op.id])
                .filter((s): s is HunkSelection => s != null && s.total > 1);
              if (tracked.length === 0) return null;
              const selected = tracked.reduce(
                (acc, s) => acc + s.selected.length,
                0,
              );
              const total = tracked.reduce((acc, s) => acc + s.total, 0);
              return selected < total
                ? ` — ${selected} of ${total} hunks selected`
                : null;
            })()}
          </span>
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void handleApproveAllFiles()}
          >
            Approve all files
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void handleRejectAllFiles()}
          >
            Reject all
          </Button>
        </div>
      ) : null}
      {filePending.map((op) => (
        <FilePermissionCard
          key={op.id}
          operation={op}
          appId={appId}
          onOnce={handleFileOnce}
          onAlwaysFile={handleFileAlwaysFile}
          onAlwaysDirectory={handleFileAlwaysDirectory}
          onAlwaysExtension={handleFileAlwaysExtension}
          onDeny={handleFileDeny}
          onHunkSelectionChange={handleHunkSelectionChange}
          hunkSelection={hunkSelections[op.id]}
        />
      ))}
      {commandPending.map((op) => (
        <CommandPermissionCard
          key={op.id}
          operation={op}
          appId={appId}
          onOnce={handleCommandOnce}
          onAlways={handleCommandAlways}
          onDeny={handleCommandDeny}
        />
      ))}
      {escalationPending.map((op) => (
        <SandboxEscalationCard
          key={op.id}
          operation={op}
          onAllow={handleSimpleAllow}
          onDeny={handleSimpleDeny}
        />
      ))}
      {automationPending.map((op) => (
        <AutomationPermissionCard
          key={op.id}
          operation={op}
          onAllow={handleSimpleAllow}
          onDeny={handleSimpleDeny}
        />
      ))}
      {mcpServerPending.map((op) => (
        <McpServerPermissionCard
          key={op.id}
          operation={op}
          onAllow={handleSimpleAllow}
          onDeny={handleSimpleDeny}
        />
      ))}
      {otherPending.map((op) => (
        <FilePermissionCard
          key={op.id}
          operation={op}
          appId={appId}
          onOnce={handleFileOnce}
          onAlwaysFile={handleFileAlwaysFile}
          onAlwaysDirectory={handleFileAlwaysDirectory}
          onAlwaysExtension={handleFileAlwaysExtension}
          onDeny={handleFileDeny}
        />
      ))}
    </div>
  );
}
