/**
 * The passkey notice shim reports, and otherwise keeps its hands off the page.
 *
 * On Windows and Linux there is no WebAuthn support (`app.configureWebAuthn` is
 * macOS-only), so `navigator.credentials.get({publicKey})` returns a promise that
 * never settles and the tab just sits there. This shim makes that visible.
 *
 * It is injected as a STRING via `executeJavaScript`, which is why it is tested
 * this way: a syntax error inside an injected string does not fail a build, does
 * not throw anywhere we would see, and simply means the notice never appears —
 * indistinguishable from the bug it exists to report. Evaluating the real script
 * text is the only check that catches that.
 *
 * The behaviours pinned here are the ones a well-meaning edit would break:
 * passthrough, single-report, leaving non-WebAuthn credential requests alone, and
 * surviving re-injection (the script is injected on BOTH `dom-ready` and
 * `did-finish-load`).
 */
import { describe, expect, it, vi } from "vitest";
import {
  WEBAUTHN_NOTICE_SCRIPT,
  WEBAUTHN_UNSUPPORTED_MESSAGE,
} from "@/lib/browser/webauthn-notice";
import { ERROR_SENTINEL, tryParseErrorSentinel } from "@/lib/browser/error-hook";

/** Run the injected script against a fake page and hand back its moving parts. */
function installShim() {
  const logged: string[] = [];
  const win: Record<string, unknown> = {};
  const getImpl = vi.fn(async (o: unknown) => ({ from: "get", o }));
  const createImpl = vi.fn(async (o: unknown) => ({ from: "create", o }));
  const navigator = { credentials: { get: getImpl, create: createImpl } };
  const location = { href: "https://example.com/login" };
  const consoleStub = { error: (s: string) => logged.push(s) };

  const run = () =>
    new Function(
      "window",
      "location",
      "console",
      "navigator",
      WEBAUTHN_NOTICE_SCRIPT,
    )(win, location, consoleStub, navigator);

  run();
  return { logged, navigator, getImpl, createImpl, run };
}

describe("WEBAUTHN_NOTICE_SCRIPT", () => {
  it("is syntactically valid and installs without throwing", () => {
    expect(() => installShim()).not.toThrow();
  });

  it("reports a passkey attempt through the EXISTING error sentinel", async () => {
    const { logged, navigator } = installShim();
    await navigator.credentials.get({ publicKey: { challenge: 1 } });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(ERROR_SENTINEL);

    // Reusing the sentinel is the whole point — it means no new IPC event, no
    // reducer branch and no rendering. So it must survive the existing parser.
    const parsed = tryParseErrorSentinel(logged[0]!);
    expect(parsed).not.toBeNull();
    expect(parsed!.message).toBe(WEBAUTHN_UNSUPPORTED_MESSAGE);
    // `warning`, not `error`: the PAGE did nothing wrong, and this must not read
    // as a page fault in the Errors tab.
    expect(parsed!.level).toBe("warning");
  });

  it("does NOT interfere — the original call still runs and its result passes through", async () => {
    const { navigator, getImpl } = installShim();
    const options = { publicKey: { challenge: 7 } };
    const result = await navigator.credentials.get(options);

    // Nothing can tell whether a future Electron or a roaming authenticator would
    // have satisfied this, so the shim reports and gets out of the way.
    expect(getImpl).toHaveBeenCalledWith(options);
    expect(result).toEqual({ from: "get", o: options });
  });

  it("reports at most ONCE per document — sites retry credential requests in a loop", async () => {
    const { logged, navigator } = installShim();
    await navigator.credentials.get({ publicKey: { challenge: 1 } });
    await navigator.credentials.get({ publicKey: { challenge: 2 } });
    await navigator.credentials.create({ publicKey: { challenge: 3 } });
    expect(logged).toHaveLength(1);
  });

  it("stays silent for password and federated credentials, which are unaffected", async () => {
    const { logged, navigator } = installShim();
    await navigator.credentials.get({ password: true });
    await navigator.credentials.get({ federated: { providers: ["x"] } });
    expect(logged).toEqual([]);
  });

  it("is idempotent — it is injected on both dom-ready and did-finish-load", async () => {
    const { logged, navigator, run } = installShim();
    run();
    run();
    await navigator.credentials.get({ publicKey: { challenge: 1 } });
    // Double-wrapping would emit twice (or more) for a single call.
    expect(logged).toHaveLength(1);
  });
});
