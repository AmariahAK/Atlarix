import { atom } from "jotai";

/**
 * Which guided-tour step is showing, or null when the tour is not running.
 *
 * An atom rather than component state because the steps are anchored to controls in
 * DIFFERENT components — the composer row owns two of them and the right panel owns
 * the third — and they have no common parent short of the layout. The previous
 * implementation solved this with `document.querySelector` against `data-tour`
 * attributes, which is how two of its four tours ended up pointing at anchors that no
 * longer exist in the DOM, silently, with nothing failing.
 */
export const guidedTourStepAtom = atom<number | null>(null);
