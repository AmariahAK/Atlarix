/**
 * The Network tab: cards per browser tab, bodies on demand, and the hand-off to
 * chat that replaced the completion gate on the user's side.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import type { NetworkEntry } from '@/lib/browser/network-entry';
import { chatInputValueAtom } from '@/atoms/chatAtoms';

const browserGetNetwork = vi.fn();
const browserGetNetworkBody = vi.fn();

vi.mock('@/ipc/ipc_client', () => ({
  IpcClient: {
    getInstance: () => ({ browserGetNetwork, browserGetNetworkBody }),
  },
}));

const { NetworkPanel } = await import('@/components/preview_panel/NetworkPanel');

function entry(over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id: over.id ?? 'r1',
    tabId: 1,
    url: 'https://api.test/users',
    method: 'GET',
    status: 200,
    startedAt: 0,
    source: 'cdp',
    ...over,
  };
}

function snapshot(tabs: Array<Partial<{ id: number; url: string; title: string; degraded: boolean; entries: NetworkEntry[] }>>) {
  return {
    tabs: tabs.map((t, i) => ({
      id: t.id ?? i + 1,
      url: t.url ?? 'https://example.com',
      title: t.title ?? 'Example',
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

describe('NetworkPanel', () => {
  it('renders one card per tab, so one page cannot read as another', async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([
        { id: 1, title: 'YouTube', entries: [entry({ id: 'a', status: 401 })] },
        { id: 2, title: 'GitHub', entries: [entry({ id: 'b', status: 500 })] },
      ]),
    );
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText('YouTube')).toBeTruthy());
    expect(screen.getByText('GitHub')).toBeTruthy();
  });

  it('shows failures by default and every request on demand', async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([
        {
          entries: [
            entry({ id: 'ok', url: 'https://api.test/fine', status: 200 }),
            entry({ id: 'bad', url: 'https://api.test/boom', status: 500 }),
          ],
        },
      ]),
    );
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText('/boom')).toBeTruthy());
    expect(screen.queryByText('/fine')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'all' }));
    });
    expect(screen.getByText('/fine')).toBeTruthy();
  });

  it('says a size is UNKNOWN rather than reporting zero', async () => {
    // A chunked or compressed response has no content-length on the fallback
    // tier. Rendering 0 B would be a measurement the panel never made.
    browserGetNetwork.mockResolvedValue(
      snapshot([{ entries: [entry({ id: 'x', status: 500, size: undefined })] }]),
    );
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText('/users')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('0 B')).toBeNull();
  });

  it('fetches a response body only when the row is expanded', async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([{ entries: [entry({ id: 'x', status: 500 })] }]),
    );
    browserGetNetworkBody.mockResolvedValue({ body: '{"error":"nope"}', base64: false });
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText('/users')).toBeTruthy());
    expect(browserGetNetworkBody).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand request' }));
    });
    await waitFor(() => expect(screen.getByText('{"error":"nope"}')).toBeTruthy());
    expect(browserGetNetworkBody).toHaveBeenCalledWith(1, 'x');
  });

  it('surfaces an evicted body as a message, not an empty one', async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([{ entries: [entry({ id: 'x', status: 500 })] }]),
    );
    browserGetNetworkBody.mockResolvedValue({
      unavailable: 'This response body is no longer buffered.',
    });
    render(<NetworkPanel active />);

    await waitFor(() => expect(screen.getByText('/users')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand request' }));
    });
    await waitFor(() =>
      expect(screen.getByText('This response body is no longer buffered.')).toBeTruthy(),
    );
  });

  it('marks a degraded tab instead of presenting a partial inventory as complete', async () => {
    browserGetNetwork.mockResolvedValue(
      snapshot([{ degraded: true, entries: [entry({ id: 'x', status: 404 })] }]),
    );
    render(<NetworkPanel active />);
    await waitFor(() => expect(screen.getByText('limited capture')).toBeTruthy());
  });

  it('sends a row to chat without eating what the user already typed', async () => {
    const store = createStore();
    store.set(chatInputValueAtom, 'my own question');
    browserGetNetwork.mockResolvedValue(
      snapshot([{ entries: [entry({ id: 'x', status: 500 })] }]),
    );
    render(
      <Provider store={store}>
        <NetworkPanel active />
      </Provider>,
    );

    await waitFor(() => expect(screen.getByText('/users')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send this request to Atlarix' }),);
    });

    const value = store.get(chatInputValueAtom);
    expect(value.startsWith('my own question')).toBe(true);
    expect(value).toContain('https://api.test/users');
  });

  it('does not poll while inactive', async () => {
    browserGetNetwork.mockResolvedValue(snapshot([]));
    render(<NetworkPanel active={false} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(browserGetNetwork).not.toHaveBeenCalled();
  });
});
