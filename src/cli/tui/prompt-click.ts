/**
 * A click, or a selection? The mouse moving one cell between press and
 * release is a click: trackpads and real mice slip that much on most taps,
 * and the terminal then reports a drag. Treated as a selection it copied two
 * characters and the next key typed over them ("hello world" + X became
 * "hello Xrld"; owner, 2026-11-07: "click and edit" didn't work).
 */
export function isClickNotSelection(anchor: { x: number; y: number }, focus: { x: number; y: number }): boolean {
  return anchor.y === focus.y && Math.abs(anchor.x - focus.x) <= 1;
}
