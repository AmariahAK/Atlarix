/**
 * The passkey notice shim reports, and otherwise keeps its hands off the page.
 *
 * The PLATFORM authenticator is unavailable on EVERY platform: Windows and Linux
 * never had one, and macOS's was removed because the `keychain-access-groups`
 * entitlement it needs is provisioned and the kernel SIGKILLed the signed build
 * without a profile. A request that resolves to it returns a promise that never
 * settles and the tab just sits there. This shim makes that visible.
 *
 * What it must NOT do is overstate that. ROAMING authenticators — a USB security
 * key, or a phone over hybrid/QR — go through Chromium and work on every platform,
 * so a request that explicitly asks for one gets no notice at all. The first
 * version reported on every `publicKey` call and told those users to go and use a
 * different browser, which was false.
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

  /**
   * The MESSAGE, pinned — it has been wrong twice, in opposite directions.
   *
   * v1 said "not available… open this page in your normal browser", which steered
   * users off the roaming path that works. v2 blamed Touch ID being "macOS-only",
   * which stopped being true when the Touch ID authenticator was removed from
   * macOS. Both were plausible sentences that shipped, so the wording is asserted
   * rather than left to review.
   */
  it("names the path that WORKS instead of refusing", () => {
    const m = WEBAUTHN_UNSUPPORTED_MESSAGE;
    // The affordance the user has to find on screen, quoted as Chromium labels it —
    // "use your phone" is advice, this is a thing they can click.
    expect(m).toMatch(/use a phone or tablet/i);
    expect(m).toMatch(/security key/i);
    expect(m).toMatch(/QR/);
  });

  it("does not blame macOS or send the user to another browser", () => {
    const m = WEBAUTHN_UNSUPPORTED_MESSAGE;
    // Both were true of an earlier version and are false now.
    expect(m).not.toMatch(/macOS|Touch ID/i);
    expect(m).not.toMatch(/normal browser|another browser/i);
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

  it("stays SILENT when the site explicitly asks for a roaming authenticator", async () => {
    // A security key or phone works on every platform, including the ones where
    // the platform authenticator does not. The first version of this shim reported
    // regardless and told those users to go and use a different browser.
    const { logged, navigator } = installShim();
    await navigator.credentials.create({
      publicKey: { authenticatorSelection: { authenticatorAttachment: "cross-platform" } },
    });
    await navigator.credentials.get({
      publicKey: { allowCredentials: [{ id: "x", transports: ["usb", "nfc"] }] },
    });
    expect(logged).toEqual([]);
  });

  it("still reports when the platform authenticator is explicitly required", async () => {
    const { logged, navigator } = installShim();
    await navigator.credentials.create({
      publicKey: { authenticatorSelection: { authenticatorAttachment: "platform" } },
    });
    expect(logged).toHaveLength(1);
  });

  it("still reports when the request says NOTHING — it may resolve to the platform", async () => {
    // Unstated is the common case and the ambiguous one. Silence here would hide a
    // real dead end, so the shim only goes quiet on an explicit roaming request.
    const { logged, navigator } = installShim();
    await navigator.credentials.get({ publicKey: { challenge: 1 } });
    expect(logged).toHaveLength(1);
  });

  it("reports when allowCredentials mixes internal with roaming transports", async () => {
    // One `internal` entry means the platform path is in play, so the notice stands.
    const { logged, navigator } = installShim();
    await navigator.credentials.get({
      publicKey: {
        allowCredentials: [
          { id: "a", transports: ["usb"] },
          { id: "b", transports: ["internal"] },
        ],
      },
    });
    expect(logged).toHaveLength(1);
  });

  it("does not promise that passkeys are unavailable outright", async () => {
    // The message must not tell a Windows/Linux user to leave: a security key or
    // phone may still work, and only the DEVICE-STORED passkey is unavailable.
    const { logged, navigator } = installShim();
    await navigator.credentials.get({ publicKey: { challenge: 1 } });
    const parsed = tryParseErrorSentinel(logged[0]!)!;
    expect(parsed.message).toMatch(/stored on this device/i);
    expect(parsed.message).toMatch(/security key|phone/i);
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
