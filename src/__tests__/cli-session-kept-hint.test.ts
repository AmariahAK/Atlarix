/**
 * With no OS key (Linux without a keyring, as on a headless box over SSH) the
 * CLI's sign-in lives only in that run. `atlarix login` says so in one line,
 * instead of leaving the next run to ask again with no reason given.
 */
import { describe, expect, it, vi } from "vitest";

let available = false;
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => available } }));

const { sessionKeptHint } = await import("@/cli/auth/account");

describe("sessionKeptHint", () => {
  it("nothing to say when the session is kept", async () => {
    available = true;
    expect(await sessionKeptHint("linux")).toBeNull();
  });

  it("one line per platform when it is not", async () => {
    available = false;
    expect(await sessionKeptHint("linux")).toBe(
      "Signed in for this run only: no keyring found (gnome-keyring or KWallet keeps it).",
    );
    expect(await sessionKeptHint("win32")).toBe("Signed in for this run only: Windows could not store the sign-in key.");
    expect(await sessionKeptHint("darwin")).toBe("Signed in for this run only: the keychain refused access.");
  });
});
