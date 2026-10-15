/**
 * What a whole-file write replaced, by the model's tool call id, for drawing
 * the finished edit: the result sent to the model carries only line counts
 * (build-branch's jsonAfterSuccessfulExec), and a write's own arguments hold
 * only the new text, so the CLI and editor cards counted it as all additions
 * (QA 15.7.1: "+1 −0" for a one-line file rewritten). Display only, in memory,
 * a few recent writes; a reopened chat draws the write as before.
 */
const MAX_WRITES = 50;
const MAX_CHARS = 200_000;
const previous = new Map<string, string>();

export function rememberWritePrevious(callId: string, oldContent: string): void {
  if (!callId || oldContent.length > MAX_CHARS) return;
  previous.delete(callId);
  previous.set(callId, oldContent);
  while (previous.size > MAX_WRITES) previous.delete(previous.keys().next().value!);
}

export function writePrevious(callId: string | undefined): string | undefined {
  return callId ? previous.get(callId) : undefined;
}
