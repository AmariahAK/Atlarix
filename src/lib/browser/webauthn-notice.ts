/**
 * Passkey attempts become VISIBLE where passkeys cannot work.
 *
 * No platform authenticator is available on ANY platform: Windows and Linux never
 * had one (the API has no Windows Hello support), and macOS's was removed because
 * the `keychain-access-groups` entitlement it needs is provisioned — without an
 * embedded profile the kernel SIGKILLs the signed app. So a site calling
 * `navigator.credentials.get({publicKey})` and resolving to a platform
 * authenticator gets a promise that never settles. The
 * tab just sits there, which reads as "Atlarix's browser is broken" rather than
 * "this browser cannot do passkeys". A silent hang is the worst shape of a missing
 * feature: nothing to see, nothing to act on.
 *
 * This reports the attempt instead. It deliberately does NOT reject the call and
 * does not touch the return value: nothing here can tell whether some future
 * Electron or a roaming USB authenticator would have satisfied the request, and
 * breaking a path that might work in order to report one that might not is a bad
 * trade. The user gets told; the page keeps whatever behaviour it had.
 *
 * Transport is the EXISTING `[[ATLARIX_ERR]]` console sentinel (see error-hook.ts),
 * which is why this needs no new IPC event, no reducer branch and no rendering: it
 * arrives in the Errors tab, in `browser_inspect(mode:"console")` and in the
 * once-per-turn runtime notice like any other captured event. Level is `warning`,
 * not `error` — the page did nothing wrong, and this must not read as a page fault.
 */
import { ERROR_SENTINEL } from "./error-hook";

/**
 * How the limitation is described, in one line, to both the user and the model.
 *
 * Two earlier versions of this were WRONG in opposite directions, which is why the
 * wording is this specific:
 *
 *  - "Passkey sign-in is not available… open this page in your normal browser" was
 *    false, because only the PLATFORM authenticator was ever unavailable. It steered
 *    users off a path that works.
 *  - The replacement blamed Touch ID being "macOS-only", which stopped being true
 *    the moment the Touch ID authenticator was removed from macOS too.
 *
 * So it now describes the REQUEST rather than the platform, and it ends with an
 * instruction instead of a refusal. Roaming authenticators — a security key, or a
 * phone over the hybrid/QR flow — go through Chromium on every platform, and that
 * phone is where the user's synced passkey already lives. Naming the actual
 * Chromium affordance ("use a phone or tablet") matters: "use your phone" is advice,
 * the quoted label is something the user can find on screen.
 */
export const WEBAUTHN_UNSUPPORTED_MESSAGE =
  "This site asked for a passkey stored on this device, which Atlarix's browser " +
  'can\'t provide. Choose "use a phone or tablet" and scan the QR code with the ' +
  "device holding your passkey, or use a security key — both work here.";

/**
 * Injected per document, exactly like ERROR_HOOK_SCRIPT, and injected ONLY where
 * `isWebAuthnAvailable()` is false — the caller decides, so this script carries no
 * platform check of its own.
 *
 * Guards, in order of how easily each would otherwise bite:
 * - idempotent per document (a re-injection must not double-wrap and emit twice),
 * - reports at most ONCE per document (sites retry credential requests in a loop,
 *   and a flood would push real errors out of the buffer),
 * - only for `publicKey` requests — `navigator.credentials` also serves password
 *   and federated credentials, which are unaffected and must stay silent,
 * - and only when the request could ACTUALLY be blocked. A site that explicitly
 *   asks for a roaming authenticator should succeed on every platform, so a notice
 *   there is pure noise. `create()` states that as
 *   `authenticatorSelection.authenticatorAttachment`; `get()` has no such field, so
 *   the equivalent signal is `allowCredentials` whose transports are all non-
 *   `internal` (usb / nfc / ble / hybrid). Anything unstated stays reported,
 *   because an unstated request MAY resolve to the platform authenticator.
 * - the original method is called with the original arguments and its result
 *   returned untouched, so the page's behaviour is unchanged,
 * - the whole thing is wrapped so a failure here can never break the page.
 */
export const WEBAUTHN_NOTICE_SCRIPT = `(() => {
  try {
    if (window.__atlarixWebAuthnNotice) return;
    window.__atlarixWebAuthnNotice = true;
    var creds = navigator.credentials;
    if (!creds) return;
    var SENT = ${JSON.stringify(ERROR_SENTINEL)};
    var MSG = ${JSON.stringify(WEBAUTHN_UNSUPPORTED_MESSAGE)};
    var reported = false;
    function report() {
      if (reported) return;
      reported = true;
      try {
        console.error(SENT + JSON.stringify({
          type: "console-error",
          level: "warning",
          message: MSG,
          url: location.href,
        }));
      } catch (e) {}
    }
    // True when the site has SAID it wants a roaming authenticator (security key
    // or phone). Those work here, so stay quiet. Unstated => still reported,
    // because it may resolve to the platform authenticator, which does not.
    function wantsRoamingOnly(pk) {
      try {
        var sel = pk.authenticatorSelection;
        if (sel && sel.authenticatorAttachment) {
          return sel.authenticatorAttachment === "cross-platform";
        }
        var allow = pk.allowCredentials;
        if (allow && allow.length) {
          // Every listed credential must declare transports, none of them
          // "internal" — one internal entry means the platform path is in play.
          return allow.every(function (c) {
            return (
              c && c.transports && c.transports.length &&
              c.transports.indexOf("internal") === -1
            );
          });
        }
      } catch (e) {}
      return false;
    }
    ["get", "create"].forEach(function (name) {
      var original = creds[name];
      if (typeof original !== "function") return;
      creds[name] = function (options) {
        // Only a WebAuthn request; password/federated credentials are unaffected.
        if (options && options.publicKey && !wantsRoamingOnly(options.publicKey)) {
          report();
        }
        return original.apply(creds, arguments);
      };
    });
  } catch (e) { /* never break the page */ }
})();`;
