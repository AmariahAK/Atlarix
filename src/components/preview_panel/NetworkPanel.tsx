/**
 * NetworkPanel
 * ============
 * The requests each browser tab made — one scrollable card per tab.
 *
 * A card per tab rather than one list with a tab filter: the confusion this
 * replaces was YouTube's activity reading as GitHub's after a navigation, and a
 * filter you have to remember to set does not fix that. The boundary is visual,
 * so it cannot be forgotten.
 *
 * There is deliberately NO "Open DevTools" button anywhere in the browser. The
 * whole point of this panel is that everything in it is also readable by the
 * agent; a human-only surface alongside it would defeat that.
 */

import { useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { cn } from '@/lib/utils';
import { ChevronRight, RefreshCw, Send } from 'lucide-react';
import { IpcClient } from '@/ipc/ipc_client';
import { useBrowserNetwork } from '@/hooks/useBrowserNetwork';
import { chatInputValueAtom } from '@/atoms/chatAtoms';
import { appendToChatInput } from '@/lib/chat/append-to-chat-input';
import {
    formatNetworkDetail,
    formatNetworkRow,
    isFailure,
    type NetworkEntry,
} from '@/lib/browser/network-entry';

type Include = 'failures' | 'all';

function statusClass(entry: NetworkEntry): string {
    if (entry.failed) return 'text-red-400';
    if (entry.status == null) return 'text-muted-foreground';
    if (entry.status >= 500) return 'text-red-400';
    if (entry.status >= 400) return 'text-orange-400';
    if (entry.status >= 300) return 'text-blue-400';
    return 'text-emerald-400';
}

/** Bytes, or an explicit dash — a missing content-length is UNKNOWN, not zero. */
function formatSize(size: number | undefined): string {
    if (size == null) return '—';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function shortUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.pathname}${u.search}` || u.host;
    } catch {
        return url;
    }
}

function NetworkRow({
    entry,
    tabId,
    onSend,
}: {
    entry: NetworkEntry;
    tabId: number;
    onSend: (text: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [body, setBody] = useState<string | null>(null);
    const [bodyState, setBodyState] = useState<'idle' | 'loading' | 'done'>('idle');

    async function toggle() {
        const next = !expanded;
        setExpanded(next);
        // Bodies are fetched ON DEMAND, once. Holding every response would cost
        // far more than it is worth, and the browser evicts them anyway.
        if (!next || bodyState !== 'idle') return;
        if (entry.responseBody !== undefined) {
            setBody(entry.responseBody);
            setBodyState('done');
            return;
        }
        setBodyState('loading');
        const result = await IpcClient.getInstance().browserGetNetworkBody(tabId, entry.id);
        setBody('unavailable' in result ? result.unavailable : result.body);
        setBodyState('done');
    }

    return (
        <div className="border-b border-border/40 font-mono text-[11px]">
            <div className="flex items-center gap-2 px-2 py-1 hover:bg-accent/30">
                <button
                    type="button"
                    onClick={() => void toggle()}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={expanded ? 'Collapse request' : 'Expand request'}
                >
                    <ChevronRight
                        className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')}
                    />
                </button>
                <span className={cn('w-14 shrink-0 tabular-nums', statusClass(entry))}>
                    {entry.failed ? 'ERR' : (entry.status ?? '…')}
                </span>
                <span className="w-12 shrink-0 text-muted-foreground uppercase">{entry.method}</span>
                <span className="flex-1 truncate" title={entry.url}>
                    {shortUrl(entry.url)}
                </span>
                <span className="w-16 shrink-0 text-right text-muted-foreground truncate">
                    {entry.resourceType ?? ''}
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                    {entry.durationMs != null ? `${entry.durationMs} ms` : '—'}
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                    {entry.fromCache ? 'cached' : formatSize(entry.size)}
                </span>
                <button
                    type="button"
                    onClick={() => onSend(formatNetworkDetail(entry))}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    title="Send this request to Atlarix"
                    aria-label="Send this request to Atlarix"
                >
                    <Send className="h-3 w-3" />
                </button>
            </div>
            {expanded && (
                <div className="px-8 pb-2 space-y-2 text-[11px] text-muted-foreground">
                    <div className="break-all">{entry.url}</div>
                    {entry.errorText && <div className="text-red-400">{entry.errorText}</div>}
                    {entry.requestHeaders && (
                        <HeaderBlock title="Request headers" headers={entry.requestHeaders} />
                    )}
                    {entry.requestBody && (
                        <BodyBlock title="Request body" text={entry.requestBody} />
                    )}
                    {entry.responseHeaders && (
                        <HeaderBlock title="Response headers" headers={entry.responseHeaders} />
                    )}
                    {bodyState === 'loading' && <div>Fetching response body…</div>}
                    {bodyState === 'done' && body != null && (
                        <BodyBlock
                            title={`Response body${entry.responseBodyTruncated ? ' (truncated)' : ''}`}
                            text={body}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

function HeaderBlock({ title, headers }: { title: string; headers: Record<string, string> }) {
    return (
        <div>
            <div className="text-foreground/70">{title}</div>
            <div className="mt-0.5 space-y-0.5">
                {Object.entries(headers).map(([k, v]) => (
                    <div key={k} className="break-all">
                        <span className="text-foreground/60">{k}:</span> {v}
                    </div>
                ))}
            </div>
        </div>
    );
}

function BodyBlock({ title, text }: { title: string; text: string }) {
    return (
        <div>
            <div className="text-foreground/70">{title}</div>
            <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2">
                {text}
            </pre>
        </div>
    );
}

function TabCard({
    tab,
    include,
    onSend,
}: {
    tab: { id: number; url: string; title: string; degraded: boolean; entries: NetworkEntry[] };
    include: Include;
    onSend: (text: string) => void;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const rows = useMemo(
        () => (include === 'all' ? tab.entries : tab.entries.filter(isFailure)),
        [tab.entries, include],
    );
    const failures = useMemo(() => tab.entries.filter(isFailure).length, [tab.entries]);

    return (
        <div className="rounded-md border border-border/60 bg-black/20">
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/40">
                <button
                    type="button"
                    onClick={() => setCollapsed((v) => !v)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={collapsed ? 'Expand tab' : 'Collapse tab'}
                >
                    <ChevronRight
                        className={cn('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-90')}
                    />
                </button>
                <span className="text-xs font-medium truncate" title={tab.url}>
                    {tab.title || tab.url || `Tab ${tab.id}`}
                </span>
                <span className="text-[11px] text-muted-foreground shrink-0">
                    {tab.entries.length} req
                </span>
                {failures > 0 && (
                    <span className="text-[11px] text-red-400 shrink-0">{failures} failed</span>
                )}
                {tab.degraded && (
                    // Say which tier produced this. The two are not interchangeable
                    // inventories, and "no request" means something different on each.
                    <span
                        className="text-[11px] text-yellow-400 shrink-0"
                        title="The debugger could not attach to this tab, so early requests may be missing and most rows have no response body."
                    >
                        limited capture
                    </span>
                )}
                {rows.length > 0 && (
                    <button
                        type="button"
                        onClick={() =>
                            onSend(
                                `Requests from ${tab.url || `tab ${tab.id}`}:\n` +
                                    rows.map(formatNetworkRow).join('\n'),
                            )
                        }
                        className="ml-auto shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                        Send to Atlarix
                    </button>
                )}
            </div>
            {!collapsed && (
                <div className="max-h-72 overflow-y-auto">
                    {rows.length === 0 ? (
                        <p className="px-3 py-3 text-[11px] text-muted-foreground">
                            {include === 'failures'
                                ? 'Nothing failed in this tab.'
                                : 'No requests recorded yet.'}
                        </p>
                    ) : (
                        rows.map((entry) => (
                            <NetworkRow
                                key={entry.id}
                                entry={entry}
                                tabId={tab.id}
                                onSend={onSend}
                            />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

export function NetworkPanel({ active }: { active: boolean }) {
    const { snapshot, loaded, refresh } = useBrowserNetwork(active);
    const [include, setInclude] = useState<Include>('failures');
    const [chatInput, setChatInput] = useAtom(chatInputValueAtom);

    function send(text: string) {
        setChatInput(appendToChatInput(chatInput, text));
    }

    const total = snapshot.tabs.reduce((n, t) => n + t.entries.length, 0);

    return (
        <div className="flex flex-col h-full min-h-0 bg-[#1e1e1e]">
            <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
                <span className="text-xs font-medium text-muted-foreground mr-1">Network</span>
                {(['failures', 'all'] as const).map((id) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setInclude(id)}
                        className={cn(
                            'px-2 py-0.5 rounded text-xs transition-colors capitalize',
                            include === id
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {id}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => void refresh()}
                    className="ml-auto text-muted-foreground hover:text-foreground"
                    aria-label="Refresh"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                </button>
            </div>

            {snapshot.tabs.length === 0 ? (
                <div className="flex-1 flex items-center justify-center p-6 text-center">
                    <p className="text-xs text-muted-foreground">
                        {loaded
                            ? 'No browser tabs open. Open a page in the Browser tab and its requests appear here.'
                            : 'Loading…'}
                    </p>
                </div>
            ) : (
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                    {total === 0 && (
                        <p className="px-1 pb-1 text-[11px] text-muted-foreground">
                            Nothing requested yet. Capture starts with the tab, so an empty card
                            means the page has not asked for anything.
                        </p>
                    )}
                    {snapshot.tabs.map((tab) => (
                        <TabCard key={tab.id} tab={tab} include={include} onSend={send} />
                    ))}
                </div>
            )}
        </div>
    );
}
