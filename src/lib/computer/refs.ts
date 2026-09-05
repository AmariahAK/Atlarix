/**
 * Refs: the short handles the model acts on, mapped to the driver's element tokens.
 *
 * # THE PLAN FOR THIS FILE WAS MUCH BIGGER, AND THE DRIVER MADE IT UNNECESSARY
 *
 * The design assumed the only addressing primitive was `element_index` — an index
 * into a snapshot cache that, per the driver's own invariant, "is replaced by the
 * next snapshot". A stale index still RESOLVES, to a different element, which is
 * precisely the failure refs exist to prevent and is what `docs/DESIGN_NOTES.md`
 * records for mobile. So the plan was to re-resolve every ref by identity
 * (`axIdentifier` → `role+name+pathKey` → `role+name+ordinal` → `role+name`) against
 * a fresh snapshot on every act.
 *
 * Reading `cua-driver describe click` showed that work is already done upstream:
 *
 *   element_token — "Opaque per-snapshot element handle from
 *   structuredContent.elements[].element_token. If element_index, snapshot_id, or
 *   window_id are also supplied they must agree. **Returns an explicit stale error
 *   once a newer snapshot supersedes it.**"
 *
 * An explicit stale error is exactly the guarantee we wanted, enforced one layer
 * lower than we could enforce it. Re-implementing identity matching on top would be
 * a second, weaker copy of a working mechanism — and a fuzzy one, since `role+name`
 * ties are common in real UIs.
 *
 * So this file is now a NAMING layer, not a correctness layer:
 *
 *   - The model sees `d3.7`: two small integers, a handful of tokens.
 *   - We hold the opaque token, which is long and carries no meaning to a model.
 *   - The generation in the ref lets us give a BETTER stale message than the driver's
 *     (naming which read it came from, and that a re-read is the fix) before the
 *     driver is even asked.
 *
 * The token remains the thing that actually decides, and we never fall back to a
 * bare `element_index`: an index without its `snapshot_id` is the unsafe primitive.
 */

/** One addressable element, as the model sees it plus what we need to act. */
export interface DesktopElement {
  /** `d<generation>.<seq>` — what the model passes back. */
  ref: string;
  role: string;
  label: string;
  /** The element's text/AXValue, when it has one. Useful to verify a field. */
  value?: string;
  /** Window-local frame, from the driver's `frame: {x,y,w,h}`. */
  frame: { x: number; y: number; w: number; h: number };
  depth: number;
  /** Opaque driver handle. Never shown to the model. */
  token: string;
}

interface Generation {
  gen: number;
  appKey: string;
  windowId?: string;
  pid: number;
  byRef: Map<string, DesktopElement>;
  takenAt: number;
}

/**
 * Keep a few generations per app, not one.
 *
 * One would be enough for the happy path, but a model legitimately interleaves: read
 * app A, read app B, then act on a ref from A. Holding only the newest read would
 * make that a stale-ref error when nothing about A's window changed. Three is enough
 * for realistic interleaving and small enough that a token cannot linger for long.
 */
const KEEP_GENERATIONS = 3;

const byApp = new Map<string, Generation[]>();
let nextGen = 1;

function keyFor(appKey: string, windowId?: string): string {
  return windowId ? `${appKey}::${windowId}` : appKey;
}

/**
 * Record a fresh snapshot and mint refs for it.
 *
 * @returns the elements, with their `ref` assigned.
 */
export function mintRefs(input: {
  appKey: string;
  pid: number;
  windowId?: string;
  elements: Array<Omit<DesktopElement, "ref">>;
}): DesktopElement[] {
  const gen = nextGen++;
  const withRefs: DesktopElement[] = input.elements.map((el, i) => ({
    ...el,
    ref: `d${gen}.${i + 1}`,
  }));

  const key = keyFor(input.appKey, input.windowId);
  const list = byApp.get(key) ?? [];
  list.push({
    gen,
    appKey: input.appKey,
    windowId: input.windowId,
    pid: input.pid,
    byRef: new Map(withRefs.map((e) => [e.ref, e])),
    takenAt: Date.now(),
  });
  // Newest last; drop the oldest beyond the window.
  while (list.length > KEEP_GENERATIONS) list.shift();
  byApp.set(key, list);
  noteWindowRead(input.pid);
  return withRefs;
}

export type RefLookup =
  | { ok: true; element: DesktopElement; pid: number; windowId?: string }
  | { ok: false; error: string };

const REF_SHAPE = /^d(\d+)\.(\d+)$/;

/**
 * Resolve a ref the model gave us.
 *
 * Every failure names the recovery, and NONE of them says "do not retry" — a stale
 * ref is category 4: re-reading and trying again is the correct response, and
 * telling the model to stop would be wrong. What it must not do is repeat the same
 * call with the same ref, so the messages say that instead.
 */
export function resolveRef(ref: string): RefLookup {
  const m = REF_SHAPE.exec(ref.trim());
  if (!m) {
    return {
      ok: false,
      error:
        `"${ref}" is not an element ref. A ref looks like "d3.7" and comes from ` +
        `computer_inspect — read the window first and use a ref from that read. ` +
        `There is no coordinate form.`,
    };
  }
  const gen = Number(m[1]);

  for (const list of byApp.values()) {
    const found = list.find((g) => g.gen === gen);
    if (!found) continue;
    const element = found.byRef.get(ref);
    if (!element) {
      return {
        ok: false,
        error:
          `Ref "${ref}" is not in read ${gen}, which had ${found.byRef.size} elements. ` +
          `Re-read the window and use a ref it actually offered.`,
      };
    }
    return { ok: true, element, pid: found.pid, windowId: found.windowId };
  }

  // The generation is gone: either evicted, or from a read that never happened.
  const live = [...byApp.values()].flat().map((g) => g.gen).sort((a, b) => b - a);
  return {
    ok: false,
    error:
      `Ref "${ref}" came from read ${gen}, which is no longer held` +
      (live.length ? ` (current reads: ${live.slice(0, KEEP_GENERATIONS).join(", ")})` : "") +
      `. Refs are valid for the read that produced them — re-read the window with ` +
      `computer_inspect and use a fresh ref. Do NOT repeat this call with the same ref.`,
  };
}

/**
 * Translate the driver's own stale-token error into our vocabulary.
 *
 * The driver's message is correct and unhelpful to a model: it talks about snapshots
 * and tokens, neither of which the model has ever seen. This keeps the CAUSE and
 * replaces the ADVICE — the same lesson as the browser tool's "Illegal invocation",
 * where a technically accurate message cost three turns because it named a
 * JavaScript invariant instead of an action.
 */
export function explainDriverStaleError(ref: string, driverMessage: string): string {
  return (
    `The window changed since the read that produced "${ref}", so acting on it was refused ` +
    `rather than applied to whatever now sits in that position. Re-read the window with ` +
    `computer_inspect and act on a fresh ref. Do NOT repeat this call with the same ref. ` +
    `(driver: ${driverMessage.slice(0, 200)})`
  );
}

/** True when a driver error is the staleness refusal rather than a real failure. */
export function isDriverStaleError(message: string): boolean {
  return /\bstale\b|superseded|snapshot.*(replaced|mismatch)|element_token.*(stale|expired)/i.test(
    message,
  );
}

// ── "did you look first" ────────────────────────────────────────────────────

/**
 * When each pid was last READ. Not the same question as ref staleness.
 *
 * The owner's decision on pixel actions was *allow them, paired with an OCR or
 * element read* — the reason OCR returning positions is useful at all. This ledger
 * is what makes "paired with" checkable: a raw `click {pid, x, y}` through
 * `computer_call` carries no ref, so nothing else in this file can tell a coordinate
 * derived from a read apart from one the model guessed.
 *
 * IT IS NOT A FRESHNESS CHECK, and conflating the two would make it both stricter
 * and less useful than it should be. Whether an ELEMENT is still the element is the
 * driver's job, and it does it properly: `element_token` "returns an explicit stale
 * error once a newer snapshot supersedes it". This only answers "did this turn ever
 * look at that window", so the window is generous on purpose — a model that reads,
 * thinks, calls another tool, then clicks is behaving well, and refusing it would be
 * a false alarm that teaches nothing.
 */
const readAt = new Map<number, number>();
const READ_RECENCY_MS = 5 * 60_000;

/** Record that we read a window belonging to `pid`. Called by every read path. */
export function noteWindowRead(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) readAt.set(pid, Date.now());
}

/** Has this turn actually looked at `pid` recently enough to be aiming at something? */
export function hasRecentReadFor(pid: number, now = Date.now()): boolean {
  const at = readAt.get(pid);
  return at !== undefined && now - at <= READ_RECENCY_MS;
}

/** Tests only. */
export function resetRefsForTests(): void {
  byApp.clear();
  readAt.clear();
  nextGen = 1;
}

export function refGenerationCountForTests(): number {
  return [...byApp.values()].flat().length;
}
