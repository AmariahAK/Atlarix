/**
 * Assemble one step's messages: the model's history, the harness's injected
 * block, and any mid-turn user messages.
 *
 * EXTRACTED TO BE TESTABLE. This lived inline in `prepareStep`, inside a
 * ~3,000-line handler where nothing could reach it, and it now carries the one
 * distinction the whole mid-turn-message feature rests on — tagged vs untagged.
 * `system-reminder.ts` states the convention: harness content travels as
 * `role:"user"` (providers reject mid-conversation `role:"system"`) and the
 * `<system-reminder>` TAG is what marks it as not-real-input — "only untagged
 * user turns are real user input". Getting that backwards is invisible on the
 * wire and changes how the model reads the user's own words, so it deserves a
 * function with a test rather than a line in a closure.
 */

export type StepMessage = { role: "user"; content: string };

/**
 * `changed` is why this returns an object. `prepareStep` may return `undefined`
 * to mean "no override", and deciding that on `injected` alone dropped an
 * interjection-only step on the floor — the user's message was drained (so
 * gone) and then never sent.
 */
export function buildStepMessages<M>(args: {
  messages: M[];
  /** The tagged harness block, already joined. Empty when there is none. */
  injected: string;
  /** The user's own mid-turn messages, oldest first. */
  interjections?: { text: string }[] | null;
  /** Wraps `injected` in the `<system-reminder>` framing. */
  tag: (s: string) => string;
}): { messages: (M | StepMessage)[]; changed: boolean } {
  const { messages, injected, interjections, tag } = args;
  const hasInterjections = (interjections?.length ?? 0) > 0;
  if (!injected && !hasInterjections) {
    return { messages, changed: false };
  }
  const out: (M | StepMessage)[] = [...messages];
  // Tagged block FIRST: it is context about the step, including the note that
  // explains the untagged messages below it.
  if (injected) out.push({ role: "user", content: tag(injected) });
  // Then the user's words, verbatim and UNTAGGED, each as its own message so a
  // correction that followed a request still reads in the order it was typed.
  // A single joined message would let a recency-biased model act on the last
  // line only.
  for (const m of interjections ?? []) {
    out.push({ role: "user", content: m.text });
  }
  return { messages: out, changed: true };
}
