/**
 * Sub-agent result envelope → display summary. Pure string functions, safe for
 * both main and renderer (same contract as `plan-checklist.ts`).
 *
 * This lived in `register-delegation-tools.ts`, which pulls in the tool registry and
 * Electron — so the renderer could not reuse it and `buildToolExpandView` had no way
 * to unwrap a `task` result. `register-delegation-tools` re-exports from here, so the
 * main-process callers and their tests are unchanged.
 */

/**
 * Unwrap the registry envelope + `<task>` / `<summary>` / `<task_result>` markup.
 *
 * The stringified envelope (`{"success":true,"result":"<task …"}`) used to render
 * verbatim in the sub-agent popup. Error detection reads `state="error"` on the
 * UNWRAPPED string because inside the stringified envelope the quotes are escaped
 * (`state=\"error\"`), which is why matching the raw string never worked.
 */
export function extractDelegationDisplaySummary(
  result: unknown,
  resultStr: string,
): { summary: string; isError: boolean; isRunning: boolean } {
  const unwrapped =
    result &&
    typeof result === "object" &&
    typeof (result as { result?: unknown }).result === "string"
      ? (result as { result: string }).result
      : resultStr;
  const isError = /state="error"/.test(unwrapped);
  // A backgrounded (or auto-promoted) task RETURNS while its sub-agent is still
  // running — the envelope says so. Callers must not treat that as completion.
  const isRunning = /state="running"/.test(unwrapped);
  const taskResult = /<task_result>([\s\S]*?)<\/task_result>/.exec(unwrapped);
  if (taskResult?.[1]?.trim()) {
    return { summary: taskResult[1].trim(), isError, isRunning };
  }
  return {
    summary: unwrapped
      .replace(/<\/?task[^>]*>/g, "")
      .replace(/<\/?summary>/g, "")
      .trim(),
    isError,
    isRunning,
  };
}

/**
 * The `<summary>` label a `task` envelope carries — the sub-agent's description,
 * used as the tool card's heading. Distinct from `<task_result>`, which is the body.
 */
export function extractDelegationScope(text: string): string | undefined {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  const scope = m?.[1]?.trim();
  return scope || undefined;
}

/** `<task_error>` body, when the envelope carries one. */
export function extractDelegationError(text: string): string | undefined {
  const m = /<task_error>([\s\S]*?)<\/task_error>/.exec(text);
  const err = m?.[1]?.trim();
  return err || undefined;
}
