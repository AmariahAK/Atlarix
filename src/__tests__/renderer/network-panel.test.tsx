/**
 * The Network tab: cards per browser tab, bodies on demand, and the hand-off to
 * chat that replaced the completion gate on the user's side.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { NetworkEntry } from "@/lib/browser/network-entry";
import { attachmentsAtom, chatInputValueAtom } from "@/atoms/chatAtoms";

const browserGetNetwork = vi.fn();
const browserGetNetworkBody = vi.fn();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({ browserGetNetwork, browserGetNetworkBody }),
  },
}));

const { NetworkPanel } = await import(
  "@/components/preview_panel/NetworkPanel"
);

function entry(over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id: over.id ?? "r1",
    tabId: 1,
    url: "https://api.test/users",
    method: "GET",
    status: 200,
    startedAt: 0,
    source: "cdp",
    ...over,
  };
}

function snapshot(
  tabs: Array<
    Partial<{
      id: number;
      url: string;
      title: string;
      degraded: boolean;
      entries: NetworkEntry[];
    }>
  >,
) {
  return {
    tabs: tabs.map((t, i) => ({
      id: t.id ?? i + 1,
      url: t.url ?? "https://example.com",
      title: t.title ?? "Example",
      degraded: t.degraded ?? false,
      entries: t.entries ?? [],
    })),
  };
}

beforeEach(() => {
  browserGetNetwork.mockReset();
  browserGetNetworkBody.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("NetworkPanel", () => {
  it("renders one card per tab, so one page cannot read as another", async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([
        { id: 1, title: "YouTube", entries: [entry({ id: "a", status: 401 })] },
        { id: 2, title: "GitHub", entries: [entry({ id: "b", status: 500 })] },
      ]),
    );
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText("YouTube")).toBeTruthy());
    expect(screen.getByText("GitHub")).toBeTruthy();
  });

  it("shows failures by default and every request on demand", async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([
        {
          entries: [
            entry({ id: "ok", url: "https://api.test/fine", status: 200 }),
            entry({ id: "bad", url: "https://api.test/boom", status: 500 }),
          ],
        },
      ]),
    );
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText("/boom")).toBeTruthy());
    expect(screen.queryByText("/fine")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "all" }));
    });
    expect(screen.getByText("/fine")).toBeTruthy();
  });

  it("says a size is UNKNOWN rather than reporting zero", async () => {
    // A chunked or compressed response has no content-length on the fallback
    // tier. Rendering 0 B would be a measurement the panel never made.
    browserGetNetwork.mockResolvedValue(
      snapshot([
        { entries: [entry({ id: "x", status: 500, size: undefined })] },
      ]),
    );
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText("/users")).toBeTruthy());
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0 B")).toBeNull();
  });

  it("fetches a response body only when the row is expanded", async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([{ entries: [entry({ id: "x", status: 500 })] }]),
    );
    browserGetNetworkBody.mockResolvedValue({
      body: '{"error":"nope"}',
      base64: false,
    });
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText("/users")).toBeTruthy());
    expect(browserGetNetworkBody).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expand request" }));
    });
    await waitFor(() =>
      expect(screen.getByText('{"error":"nope"}')).toBeTruthy(),
    );
    expect(browserGetNetworkBody).toHaveBeenCalledWith(1, "x");
  });

  it("surfaces an evicted body as a message, not an empty one", async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([{ entries: [entry({ id: "x", status: 500 })] }]),
    );
    browserGetNetworkBody.mockResolvedValue({
      unavailable: "This response body is no longer buffered.",
    });
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText("/users")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expand request" }));
    });
    await waitFor(() =>
      expect(
        screen.getByText("This response body is no longer buffered."),
      ).toBeTruthy(),
    );
  });

  it("marks a degraded tab instead of presenting a partial inventory as complete", async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([
        { degraded: true, entries: [entry({ id: "x", status: 404 })] },
      ]),
    );
    render(<NetworkPanel active />);
    await waitFor(() =>
      expect(screen.getByText("limited capture")).toBeTruthy(),
    );
  });

  it("sends a row to chat without eating what the user already typed", async () => {
    const store = createStore();
    store.set(chatInputValueAtom, "my own question");
    browserGetNetwork.mockResolvedValue(
      snapshot([{ entries: [entry({ id: "x", status: 500 })] }]),
    );
    render(
      <Provider store={store}>
        <NetworkPanel active />
      </Provider>,
    );

    await waitFor(() => expect(screen.getByText("/users")).toBeTruthy());
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send this request to Atlarix" }),
      );
    });

    const value = store.get(chatInputValueAtom);
    expect(value.startsWith("my own question")).toBe(true);
    expect(value).toContain("https://api.test/users");
  });

  /**
   * One tab, two pages. Navigating clears nothing (an integration run watched
   * youtube → github grow one tab's log 43 → 105), and Network had no navigation
   * marker at all — so a card titled with the tab's CURRENT url listed requests
   * from every page it had ever visited, and its send shipped all of them.
   */
  it("splits one tab into a card per page load", async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([
        {
          id: 1,
          url: "https://github.com",
          entries: [
            entry({
              id: "a",
              navSeq: 1,
              pageUrl: "https://youtube.com",
              status: 401,
            }),
            entry({
              id: "b",
              navSeq: 2,
              pageUrl: "https://github.com",
              status: 500,
            }),
          ],
        },
      ]),
    );
    render(<NetworkPanel active />);

    await waitFor(() =>
      expect(screen.getByTitle("https://youtube.com")).toBeTruthy(),
    );
    expect(screen.getByTitle("https://github.com")).toBeTruthy();
    // Two separate sends, so neither can carry the other page's requests.
    expect(
      screen.getAllByRole("button", { name: "Send to Atlarix" }),
    ).toHaveLength(2);
  });

  it("sends a whole card as an attachment chip rather than raw text", async () => {
    const store = createStore();
    store.set(chatInputValueAtom, "my own question");
    // Enough rows to clear the long-paste threshold the composer already uses.
    const rows = Array.from({ length: 30 }, (_, i) =>
      entry({ id: `r${i}`, url: `https://api.test/thing/${i}`, status: 500 }),
    );
    browserGetNetwork.mockResolvedValue(
      snapshot([{ id: 1, url: "https://github.com", entries: rows }]),
    );
    render(
      <Provider store={store}>
        <NetworkPanel active />
      </Provider>,
    );

    await waitFor(() => expect(screen.getByText("/thing/0")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send to Atlarix" }));
    });

    // The composer text is untouched — that is the whole point.
    expect(store.get(chatInputValueAtom)).toBe("my own question");
    const attachments = store.get(attachmentsAtom);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].textPaste?.displayName).toBe(
      "Network · github.com · 30 requests",
    );
    expect(attachments[0].textPaste?.content).toContain("/thing/29");
  });

  it("does not poll while inactive", async () => {
    browserGetNetwork.mockResolvedValue(snapshot([]));
    render(<NetworkPanel active={false} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(browserGetNetwork).not.toHaveBeenCalled();
  });
});
