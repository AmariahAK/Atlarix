// @vitest-environment jsdom
/**
 * 2026-10-26: the owner's download of 15.11.1 died at 17% and the banner stayed
 * on "Downloading update…", because it never listened to update:status. A
 * failed download or install clears it, on every updater (electron-updater and
 * Squirrel both record "error" there).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Fn<T> = (p: T) => void;
const { ipc } = vi.hoisted(() => {
  const subs = {
    downloading: [] as Fn<{ version: string }>[],
    downloaded: [] as Fn<{ version: string }>[],
    status: [] as Fn<{ lastResult: string }>[],
  };
  const on = <T,>(list: Fn<T>[]) => (h: Fn<T>) => {
    list.push(h);
    return () => list.splice(list.indexOf(h), 1);
  };
  return {
    ipc: {
      subs,
      client: {
        onUpdateDownloading: on(subs.downloading),
        onUpdateDownloaded: on(subs.downloaded),
        onUpdateStatus: on(subs.status),
        onUpdateAvailable: () => () => {},
        installUpdateNow: () => {},
        deferUpdate: async () => {},
        openExternalUrl: async () => {},
      },
    },
  };
});
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => ipc.client } }));

import { UpdateBanner } from "@/components/UpdateBanner";

const emit = {
  downloading: (version: string) => act(() => ipc.subs.downloading.forEach((h) => h({ version }))),
  downloaded: (version: string) => act(() => ipc.subs.downloaded.forEach((h) => h({ version }))),
  status: (lastResult: string) => act(() => ipc.subs.status.forEach((h) => h({ lastResult }))),
};

describe("UpdateBanner after a failure", () => {
  // This vitest setup's localStorage is not a working Storage: give the banner one.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(cleanup);

  it("a failed download clears 'Downloading…' and says it will retry", () => {
    render(<UpdateBanner />);
    emit.downloading("15.11.1");
    expect(screen.getByText(/Downloading update 15\.11\.1/)).toBeTruthy();
    emit.status("error");
    expect(screen.queryByText(/Downloading update/)).toBeNull();
    expect(screen.getByText("Update failed. Retrying soon.")).toBeTruthy();
  });

  it("the retry's download brings the progress back, and it can still finish", () => {
    render(<UpdateBanner />);
    emit.downloading("15.11.1");
    emit.status("error");
    emit.downloading("15.11.1");
    expect(screen.queryByText("Update failed. Retrying soon.")).toBeNull();
    expect(screen.getByText(/Downloading update 15\.11\.1/)).toBeTruthy();
    emit.downloaded("15.11.1");
    expect(screen.getByText(/15\.11\.1 is ready to install/)).toBeTruthy();
  });

  it("a failed install (pkexec refused) clears 'ready to install'", () => {
    render(<UpdateBanner />);
    emit.downloaded("15.11.1");
    emit.status("error");
    expect(screen.queryByText(/ready to install/)).toBeNull();
    expect(screen.getByText("Update failed. Retrying soon.")).toBeTruthy();
  });

  it("a background check failing with nothing on screen stays quiet", () => {
    const { container } = render(<UpdateBanner />);
    emit.status("error");
    expect(container.textContent).toBe("");
  });
});
