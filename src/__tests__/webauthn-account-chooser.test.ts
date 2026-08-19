/**
 * The passkey account chooser must call back EXACTLY ONCE, on every path.
 *
 * Electron holds the credential request open until the `select-webauthn-account`
 * callback runs: "The credential request remains pending until the listener invokes
 * the callback, so always invoke it exactly once." A missed call is not a declined
 * sign-in, it is an indefinite hang — the same failure class as the approval card
 * that sat waiting for ten minutes until Stop, which this release already fixed
 * once. So the contract is pinned directly rather than inferred from behaviour.
 *
 * The handler previously declined outright whenever a site offered more than one
 * credential. That was a dead end everywhere, and a worse one than it looked: the
 * event also fires for ROAMING authenticators on Windows and Linux, so a security
 * key holding two credentials could never be used.
 *
 * The logic is exercised through a local mirror of the handler rather than through
 * `browser_view_manager`, which needs a real Electron session to construct.
 */
import { describe, expect, it, vi } from "vitest";

type Account = { credentialId: string; name?: string; displayName?: string };

/** Mirrors the `select-webauthn-account` handler in browser_view_manager.ts. */
async function chooseAccount(
  details: { relyingPartyId: string; accounts?: Account[] },
  callback: (id: string | null) => void,
  showMessageBox: (opts: {
    buttons: string[];
  }) => Promise<{ response: number }>,
): Promise<void> {
  const accounts = details.accounts ?? [];
  let chosen: string | null = null;
  try {
    if (accounts.length === 1) {
      chosen = accounts[0]!.credentialId;
    } else if (accounts.length > 1) {
      const labels = accounts.map(
        (a, i) => a.displayName || a.name || `Account ${i + 1}`,
      );
      const { response } = await showMessageBox({ buttons: [...labels, "Cancel"] });
      chosen = response < labels.length ? accounts[response]!.credentialId : null;
    }
  } catch {
    chosen = null;
  } finally {
    callback(chosen);
  }
}

const rp = { relyingPartyId: "github.com" };

describe("passkey account chooser", () => {
  it("answers a single credential directly, with no dialog", async () => {
    const cb = vi.fn();
    const box = vi.fn();
    await chooseAccount({ ...rp, accounts: [{ credentialId: "only" }] }, cb, box);
    expect(box).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledExactlyOnceWith("only");
  });

  it("asks the user when there are several, and returns the chosen credential", async () => {
    const cb = vi.fn();
    const box = vi.fn(async () => ({ response: 1 }));
    await chooseAccount(
      {
        ...rp,
        accounts: [
          { credentialId: "a", name: "ada@example.com" },
          { credentialId: "b", name: "grace@example.com" },
        ],
      },
      cb,
      box,
    );
    expect(cb).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("labels buttons by displayName, then name, then a positional fallback", async () => {
    const cb = vi.fn();
    // Declare the parameter: an argument-less `vi.fn` types `mock.calls` as an
    // empty tuple, so reading calls[0][0] fails to compile even though it runs.
    const box = vi.fn(async (_opts: { buttons: string[] }) => ({ response: 0 }));
    await chooseAccount(
      {
        ...rp,
        accounts: [
          { credentialId: "a", displayName: "Ada Lovelace", name: "ada@x.com" },
          { credentialId: "b", name: "grace@x.com" },
          { credentialId: "c" },
        ],
      },
      cb,
      box,
    );
    expect(box.mock.calls[0]![0].buttons).toEqual([
      "Ada Lovelace",
      "grace@x.com",
      "Account 3",
      "Cancel",
    ]);
  });

  it("treats Cancel as a decline — exactly one callback, with null", async () => {
    const cb = vi.fn();
    // Cancel is the last button, i.e. index === labels.length.
    const box = vi.fn(async () => ({ response: 2 }));
    await chooseAccount(
      { ...rp, accounts: [{ credentialId: "a" }, { credentialId: "b" }] },
      cb,
      box,
    );
    expect(cb).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("declines rather than hanging when the dialog THROWS", async () => {
    // The path that matters most: without the `finally`, this leaves the page
    // waiting forever instead of failing a sign-in.
    const cb = vi.fn();
    const box = vi.fn(async () => {
      throw new Error("no window available");
    });
    await chooseAccount(
      { ...rp, accounts: [{ credentialId: "a" }, { credentialId: "b" }] },
      cb,
      box,
    );
    expect(cb).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("still calls back when the account list is empty or missing", async () => {
    const cb = vi.fn();
    const box = vi.fn();
    await chooseAccount({ ...rp, accounts: [] }, cb, box);
    await chooseAccount({ ...rp }, cb, box);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, null);
    expect(cb).toHaveBeenNthCalledWith(2, null);
  });
});
