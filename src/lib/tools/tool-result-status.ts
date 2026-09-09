/**
 * One definition of "this tool call failed".
 *
 * WHY THIS EXISTS
 * ---------------
 * Tools report failure two ways: by THROWING, and by RETURNING a failure shape
 * (`{success:false, …}`, or the legacy bare `{error:"…"}` that `edit_file`/`plan` use).
 * Both are normalized into the same error envelope by the registry, and the model sees
 * either as a failure.
 *
 * The UI did not. `activityStatus` in the build/ask turn runners was set to `"error"` only
 * inside a `catch`, so a tool that RETURNED a failure emitted `status: "done"` — and the
 * card rendered with a green check and the past-tense success label. `glob` refusing a
 * pattern showed as **"Found files matching ../telios/*"** with a tick beside the error
 * text. Same class as v14.22.0's `run_command` reporting "Successfully executed" next to a
 * non-zero exit, and it affects every tool using the return convention, not just `glob`.
 *
 * The predicate was inline in `registry.ts`, with five other near-variants scattered
 * around the renderer (`inline-timeline.ts`, `format-tool-result.ts`, `delegate-handoff.ts`,
 * `stream-tool-display.ts`, `run-subagent.ts`). `run-subagent.ts` had it RIGHT
 * (`parsed?.error || parsed?.success === false`) while the main turn runners did not, which
 * is exactly the drift a shared definition prevents.
 */

/**
 * True when a tool's raw return value means "this call failed".
 *
 * Not a failure: a successful result that merely *contains* the word error, an array, a
 * string, or `{success:true, error:null}`. The bare-error case requires a non-empty string
 * `error` AND `success !== true`, so a tool that explicitly succeeded is never overridden.
 */
export function isFailedToolResult(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const o = raw as { success?: unknown; error?: unknown };
  if (o.success === false) return true;
  return (
    o.success !== true &&
    typeof o.error === "string" &&
    o.error.trim().length > 0
  );
}

/**
 * Activity status for a completed tool call, from its result.
 *
 * `threw` short-circuits: an exception is a failure whatever the (absent) result looks
 * like.
 */
export function toolActivityStatusFor(
  raw: unknown,
  opts?: { threw?: boolean },
): "done" | "error" {
  if (opts?.threw) return "error";
  return isFailedToolResult(raw) ? "error" : "done";
}
