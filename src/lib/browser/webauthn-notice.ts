/**
 * Passkey attempts become VISIBLE where passkeys cannot work.
 *
 * On macOS the app configures Touch ID (`main/webauthn.ts`) and passkeys work. On
 * Windows and Linux there is no equivalent — `app.configureWebAuthn` is macOS-only
 * and there is no Windows Hello support in the API — so a site calling
 * `navigator.credentials.get({publicKey})` gets a promise that never settles. The
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
 * Says DEVICE-STORED deliberately. The first version of this said "Passkey sign-in
 * is not available… open this page in your normal browser", which is FALSE on
 * Windows and Linux: only the PLATFORM authenticator needs the macOS-only
 * `app.configureWebAuthn`. Roaming authenticators — a USB security key, or a phone
 * over the hybrid/QR flow — go through Chromium and should work there already
 * (Electron's own `select-webauthn-account` docs note the event "may also fire on
 * other platforms when a roaming FIDO2 authenticator returns multiple discoverable
 * credentials"). Telling those users to leave was steering them off a path that
 * works.
 */
export const WEBAUTHN_UNSUPPORTED_MESSAGE =
  "A passkey stored on this device can't be used in Atlarix's browser here " +
  "(that needs Touch ID, which is macOS-only). A security key or your phone may " +
  "still work — otherwise open this page in your normal browser.";

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
