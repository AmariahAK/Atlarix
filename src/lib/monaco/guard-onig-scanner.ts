/**
 * onigasm@2.x (old Oniguruma WASM) throws "invalid pattern in look-behind" on
 * the variable-length look-behind patterns modern TextMate grammars use heavily
 * (python.json alone has ~20+). The throw fires on *every* background-tokenize
 * line, flooding the console and Sentry. Guard the scanner at its source so a
 * rejected pattern degrades to "no match" (those tokens just don't highlight)
 * instead of crashing the tokenizer.
 */

let onigScannerGuarded = false;
const GUARD_FLAG = "__atlarixOnigGuarded";

/**
 * Wrap onigasm's `OnigScanner.findNextMatch(Sync)` so a pattern the engine
 * rejects degrades to "no match" instead of throwing on every tokenized line.
 * Idempotent — patches the prototype once per process.
 */
export function guardOnigScanner(onigasm: unknown): void {
  if (onigScannerGuarded) return;
  const OnigScanner = (
    onigasm as { OnigScanner?: { prototype?: Record<string, unknown> } }
  )?.OnigScanner;
  const proto = OnigScanner?.prototype;
  if (!proto || proto[GUARD_FLAG]) {
    onigScannerGuarded = true;
    return;
  }
  for (const method of ["findNextMatchSync", "findNextMatch"] as const) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function guarded(this: unknown, ...args: unknown[]) {
      try {
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } catch {
        // Unsupported pattern — treat the line as no-match (no highlight)
        // rather than letting the tokenizer throw/retry forever.
        return null;
      }
    };
  }
  proto[GUARD_FLAG] = true;
  onigScannerGuarded = true;
}

/** Test-only: clear the once-per-process latch so a fresh stub can be guarded. */
export function __resetOnigGuardForTests(): void {
  onigScannerGuarded = false;
}
