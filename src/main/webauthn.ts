/**
 * Passkeys (WebAuthn) for the in-app browser — Electron >= 42, macOS only.
 *
 * Before this, a site asking for a passkey got NOTHING: Electron had no WebAuthn
 * API at all, so the request never resolved and the tab simply sat there. It read
 * to users as "Atlarix's browser is broken", and it was NOT fixable from the
 * permission handler in `browser_view_manager` — WebAuthn is not one of Electron's
 * permission types, so `setPermissionRequestHandler` never sees the request.
 *
 * SCOPE, stated plainly because release notes must not overclaim: this is Touch ID
 * / Secure Enclave on THIS Mac. Credentials are device-bound and are NOT synced
 * through iCloud Keychain, and the API has no Windows Hello equivalent. Windows and
 * Linux get the reporting shim in the browser instead, so the failure is at least
 * visible there.
 *
 * Lives in its own module rather than as an exported const in `main.ts` so the
 * browser layer can ask whether passkeys are live without importing the entry
 * point (and running its boot side effects).
 */
import { app } from "electron";
import log from "electron-log";

const logger = log.scope("webauthn");

/**
 * MUST be byte-identical to `keychain-access-groups` in entitlements.plist — a
 * mismatch fails at credential-creation time, not at launch. Shape is
 * `<TEAM_ID>.<CFBundleIdentifier>.webauthn`; the team id is the one in
 * forge.config.ts's signing identity, and the bundle id is `com.electron.atlarix`,
 * @electron/packager's DEFAULT (packagerConfig sets no `appBundleId`).
 *
 * That default is deliberately kept: macOS ties safeStorage's keychain ACL to the
 * app's designated requirement, so renaming the bundle risks every user's stored
 * provider keys and Supabase session failing to decrypt. See docs/TODO.md.
 */
const KEYCHAIN_ACCESS_GROUP = "7VWW7N9R87.com.electron.atlarix.webauthn";

let configured = false;

/**
 * Call EARLY in boot — Electron documents `configureWebAuthn` as needing to run
 * before notifications are shown, and it must be in place before any tab can
 * issue a credential request.
 */
export function configureWebAuthn(): boolean {
  if (process.platform !== "darwin") return (configured = false);
  // Guarded rather than assumed: the typings are Electron 43's, but a downgrade
  // below 42 must fall back to the browser shim, not crash on boot.
  if (typeof app.configureWebAuthn !== "function") {
    logger.warn("app.configureWebAuthn unavailable — passkeys disabled");
    return (configured = false);
  }
  try {
    app.configureWebAuthn({
      touchID: {
        keychainAccessGroup: KEYCHAIN_ACCESS_GROUP,
        // macOS renders this as: "Atlarix" is trying to sign in to <site>.
        // `$1` is substituted with the relying party id.
        promptReason: "sign in to $1",
      },
    });
    logger.info("Touch ID configured");
    return (configured = true);
  } catch (e) {
    // An entitlement mismatch surfaces HERE rather than at credential time, and a
    // passkey feature that silently does nothing is the bug being fixed.
    logger.error("configureWebAuthn failed:", e);
    return (configured = false);
  }
}

/**
 * Whether a passkey request can actually succeed. Drives the browser-side notice:
 * where this is false, an attempt would hang forever with nothing reported.
 */
export function isWebAuthnAvailable(): boolean {
  return configured;
}
