/**
 * PageConsole
 * ===========
 * The page's own console, as a chronological stream — timestamp, level,
 * message, source, expandable stack.
 *
 * Deliberately NOT the file-grouped presentation the build errors use above it.
 * Build errors are a set of problems to work through, so grouping by file is
 * right for them; a console is a sequence of events, and reordering it destroys
 * the only thing it tells you.
 */

import { useMemo, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Virtuoso } from 'react-virtuoso';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ChevronRight, Send, Trash2 } from 'lucide-react';
import { attachmentsAtom, chatInputValueAtom } from '@/atoms/chatAtoms';
import { appendToChatInput } from '@/lib/chat/append-to-chat-input';
import {
    buildBrowserLogAttachment,
    shouldAttachBrowserLog,
    upsertBrowserLogAttachment,
} from '@/lib/chat/browser-log-attachment';
import { groupByNavigationEpoch } from '@/lib/browser/navigation-epoch';
import {
    consoleLevelFilterAtom,
    pageConsoleAtom,
    visiblePageConsoleAtom,
    type ConsoleLevelFilter,
    type PageConsoleEntry,
} from '@/atoms/sourceAtoms';

/**
 * Send a chunk of console to chat. `scope` describes WHAT is being sent, so a
 * substantial send can become a named attachment chip instead of raw text; omit
 * it and the text always goes inline.
 */
type ConsoleSend = (
    text: string,
    scope?: { label: string; count: number; scopeKey: string },
) => void;

const FILTERS: Array<{ id: ConsoleLevelFilter; label: string }> = [
    { id: 'problems', label: 'Problems' },
    { id: 'all', label: 'All' },
    { id: 'errors', label: 'Errors' },
    { id: 'warnings', label: 'Warnings' },
    { id: 'logs', label: 'Logs' },
];

function levelOf(entry: PageConsoleEntry): string {
    if (entry.type !== 'console-error') return entry.type;
    return entry.level ?? 'log';
}

const LEVEL_CLASS: Record<string, string> = {
    error: 'text-red-400',
    warning: 'text-yellow-400',
    info: 'text-blue-400',
    debug: 'text-muted-foreground',
    log: 'text-foreground/80',
    'load-failed': 'text-red-400',
    'render-gone': 'text-red-400',
    'network-failed': 'text-orange-400',
};

function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * A navigation divider. The console is deliberately NOT cleared on navigate —
 * the agent may be comparing two loads — so this is what tells you where the
 * previous page's output ends.
 */
function NavigationSeparator({ entry }: { entry: PageConsoleEntry }) {
    return (
        <div className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <span className="shrink-0 truncate" title={entry.url}>
                ↳ {entry.url ?? entry.message}
            </span>
            <span className="h-px flex-1 bg-border" />
        </div>
    );
}

/** One entry as text for the chat hand-off — the row, as read, plus its stack. */
export function formatConsoleEntry(entry: PageConsoleEntry): string {
    const tag = entry.type === 'console-error' ? (entry.level ?? 'log') : entry.type;
    return (
        `[${tag}] ${entry.message}${entry.url ? ` (${entry.url})` : ''}` +
        (entry.stack ? `\n${entry.stack}` : '')
    );
}

function ConsoleRow({
    entry,
    onSend,
}: {
    entry: PageConsoleEntry;
    onSend: ConsoleSend;
}) {
    const [expanded, setExpanded] = useState(false);
    const level = levelOf(entry);
    const hasStack = Boolean(entry.stack);

    if (entry.type === 'navigated') return <NavigationSeparator entry={entry} />;

    return (
        <div
            className={cn(
                'px-3 py-1.5 border-b border-border/40 font-mono text-xs',
                level === 'error' && 'bg-red-500/5',
                level === 'warning' && 'bg-yellow-500/5',
            )}
        >
            <div className="flex items-start gap-2">
                <span className="shrink-0 text-muted-foreground tabular-nums">
                    {formatTime(entry.timestamp)}
                </span>
                <span className={cn('shrink-0 uppercase tracking-wide', LEVEL_CLASS[level] ?? '')}>
                    {level}
                </span>
                {entry.unrelated && (
                    // Same idea as a plan step's `external` state: visible, explicitly not
                    // the agent's. Errors buffer per WINDOW, so another tab's output lands
                    // here too and would otherwise read as this page's failure.
                    <span className="shrink-0 text-muted-foreground" title="From a different browser tab">
                        [other tab]
                    </span>
                )}
                <span className="flex-1 whitespace-pre-wrap break-words">{entry.message}</span>
                <button
                    type="button"
                    // A row is usually one line and goes inline, but a stack trace
                    // can be enormous — the threshold decides, not the affordance.
                    onClick={() =>
                        onSend(formatConsoleEntry(entry), {
                            label: entry.pageUrl ?? entry.url ?? 'console entry',
                            count: 1,
                            scopeKey: `${entry.tabId ?? 'none'}:${entry.navSeq ?? 0}:${entry.timestamp}`,
                        })
                    }
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    title="Send this entry to Atlarix"
                    aria-label="Send this entry to Atlarix"
                >
                    <Send className="h-3 w-3" />
                </button>
                {hasStack && (
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={expanded ? 'Hide stack' : 'Show stack'}
                    >
                        <ChevronRight
                            className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
                        />
                    </button>
                )}
            </div>
            {entry.url && (
                <div className="mt-0.5 pl-1 text-[11px] text-muted-foreground truncate" title={entry.url}>
                    {entry.url}
                </div>
            )}
            {expanded && entry.stack && (
                <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                    {entry.stack}
                </pre>
            )}
        </div>
    );
}

/**
 * Split the stream into one card per PAGE LOAD, newest activity last.
 *
 * This was one card per TAB, which made the navigation divider decorative and
 * the label actively wrong: a tab that went youtube.com → github.com produced a
 * single card TITLED "github.com" that also held YouTube's console, and whose
 * "Send to Atlarix" shipped both pages. Grouping on `(tabId, navSeq)` — the
 * epoch stamped in main — means a card's title always names the page that
 * produced its contents, and a send is scoped to one load.
 *
 * Navigating still clears nothing; the earlier page becomes its own card instead
 * of disappearing, because comparing two loads is often the whole point.
 *
 * Exported for the test that pins it: the reason cards exist at all is that one
 * page's output used to read as another's failure, so a grouping that silently
 * dropped entries — no `tabId`, or recorded before the first navigation — would
 * reintroduce exactly that by making them vanish.
 */
export function groupByTab(
    entries: PageConsoleEntry[],
): Array<{
    tabId: number | null;
    navSeq: number;
    label: string;
    entries: PageConsoleEntry[];
}> {
    // Effective epoch per entry. The stamp from main is authoritative, but the
    // console stream also carries `navigated` markers, so when a stamp is absent
    // — capture that began mid-session, or an entry from an older build — the
    // boundary is still derivable here. Belt and braces on purpose: "a card never
    // spans a navigation" should be a property of this function, not a promise
    // about what some other process remembered to attach.
    const syntheticByTab = new Map<number | null, number>();
    const stamped = entries.map((e) => {
        const tabId = e.tabId ?? null;
        if (e.navSeq != null) return { entry: e, navSeq: e.navSeq, pageUrl: e.pageUrl };
        if (e.type === 'navigated') {
            syntheticByTab.set(tabId, (syntheticByTab.get(tabId) ?? 0) + 1);
        }
        return {
            entry: e,
            navSeq: syntheticByTab.get(tabId) ?? 0,
            pageUrl: e.pageUrl,
        };
    });

    return groupByNavigationEpoch(stamped, (s) => ({
        tabId: s.entry.tabId ?? null,
        navSeq: s.navSeq,
        pageUrl: s.pageUrl,
    }))
        .map((g) => ({ ...g, entries: g.entries.map((s) => s.entry) }))
        .map((group) => {
        // Prefer the stamped page url; fall back to this load's own `navigated`
        // marker, since capture can begin mid-load and leave the stamp absent
        // where a marker is present. Then the bare tab number.
        const markerUrl = group.entries.find((e) => e.type === 'navigated')?.url;
        return {
            tabId: group.tabId,
            navSeq: group.navSeq,
            label:
                group.pageUrl ??
                markerUrl ??
                (group.tabId == null ? 'Unattributed' : `Tab ${group.tabId}`),
            entries: group.entries,
        };
    });
}

function TabConsoleCard({
    group,
    onSend,
}: {
    group: {
        tabId: number | null;
        navSeq: number;
        label: string;
        entries: PageConsoleEntry[];
    };
    onSend: ConsoleSend;
}) {
    const [collapsed, setCollapsed] = useState(false);
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
                <span className="text-xs font-medium truncate" title={group.label}>
                    {group.label}
                </span>
                <span className="text-[11px] text-muted-foreground shrink-0">
                    {group.entries.length}
                </span>
                <button
                    type="button"
                    onClick={() => {
                        const rows = group.entries.filter((e) => e.type !== 'navigated');
                        onSend(
                            `Console from ${group.label}:\n` +
                                rows.map(formatConsoleEntry).join('\n'),
                            // Scoped to THIS page load, so sending the GitHub card
                            // can no longer carry the YouTube output that preceded
                            // it in the same tab.
                            {
                                label: group.label,
                                count: rows.length,
                                scopeKey: `${group.tabId ?? 'none'}:${group.navSeq}`,
                            },
                        );
                    }}
                    className="ml-auto shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                >
                    Send to Atlarix
                </button>
            </div>
            {!collapsed && (
                // Bounded per card. The main process already caps each tab, so
                // this list is short enough not to need virtualizing — and a card
                // that grows without limit is not a card.
                <div className="max-h-72 overflow-y-auto">
                    {group.entries.map((entry, i) => (
                        <ConsoleRow key={`${entry.timestamp}-${i}`} entry={entry} onSend={onSend} />
                    ))}
                </div>
            )}
        </div>
    );
}

export function PageConsole() {
    const [filter, setFilter] = useAtom(consoleLevelFilterAtom);
    const [entries, setEntries] = useAtom(pageConsoleAtom);
    const visible = useAtomValue(visiblePageConsoleAtom);
    const [chatInput, setChatInput] = useAtom(chatInputValueAtom);
    const setAttachments = useSetAtom(attachmentsAtom);

    // "Send to Atlarix" is what replaced the completion gate for the cases where
    // something genuinely IS broken. The harness cannot tell whose error it is;
    // the person looking at it can.
    //
    // Anything substantial arrives as an attachment CHIP rather than raw text:
    // pasting a busy tab's console into the composer buried whatever the user was
    // half-way through typing. Short sends stay inline, because a chip around one
    // console line is bigger than the line.
    function send(text: string, scope?: { label: string; count: number; scopeKey: string }) {
        if (scope && shouldAttachBrowserLog(text)) {
            setAttachments((prev) =>
                upsertBrowserLogAttachment(
                    prev,
                    buildBrowserLogAttachment({
                        source: 'Console',
                        label: scope.label,
                        count: scope.count,
                        scopeKey: scope.scopeKey,
                        content: text,
                    }),
                ),
            );
            toast.success('Added console output to chat');
            return;
        }
        setChatInput(appendToChatInput(chatInput, text));
    }

    const groups = useMemo(() => groupByTab(visible), [visible]);

    const counts = useMemo(() => {
        let errors = 0;
        let warnings = 0;
        for (const e of entries) {
            const l = levelOf(e);
            if (l === 'error' || l === 'load-failed' || l === 'render-gone') errors++;
            else if (l === 'warning') warnings++;
        }
        return { errors, warnings };
    }, [entries]);

    return (
        <div className="flex flex-col min-h-0 flex-1">
            <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
                <span className="text-xs font-medium text-muted-foreground mr-1">Page console</span>
                {FILTERS.map((f) => (
                    <button
                        key={f.id}
                        type="button"
                        onClick={() => setFilter(f.id)}
                        className={cn(
                            'px-2 py-0.5 rounded text-xs transition-colors',
                            filter === f.id
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {f.label}
                    </button>
                ))}
                <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {counts.errors > 0 && <span className="text-red-400">{counts.errors} errors</span>}
                    {counts.warnings > 0 && (
                        <span className="text-yellow-400">{counts.warnings} warnings</span>
                    )}
                    {visible.length > 0 && (
                        <button
                            type="button"
                            onClick={() => {
                                const rows = visible.filter((e) => e.type !== 'navigated');
                                send(rows.map(formatConsoleEntry).join('\n'), {
                                    label: 'all tabs',
                                    count: rows.length,
                                    scopeKey: 'all',
                                });
                            }}
                            className="hover:text-foreground"
                            title="Send everything shown to Atlarix"
                        >
                            Send all
                        </button>
                    )}
                    {entries.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setEntries([])}
                            className="hover:text-foreground"
                            aria-label="Clear console"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {visible.length === 0 ? (
                <div className="flex-1 flex items-center justify-center p-6 text-center">
                    <p className="text-xs text-muted-foreground">
                        {entries.length === 0
                            ? 'Nothing logged yet. Open a page in the Browser tab and its console appears here.'
                            : `Nothing at this level. ${entries.length} entries hidden by the filter.`}
                    </p>
                </div>
            ) : groups.length === 1 ? (
                // ONE tab: no card. There is nothing to separate, and a frame
                // around the only thing on screen is chrome for its own sake.
                // Virtualized, because a page logging in a loop would otherwise
                // mount thousands of rows and drop frames.
                <Virtuoso
                    className="flex-1"
                    data={visible}
                    followOutput="smooth"
                    itemContent={(_i, entry) => <ConsoleRow entry={entry} onSend={send} />}
                />
            ) : (
                // SEVERAL tabs: a card each, matching the Network tab. This is
                // the fix for a second tab's output reading as this page's
                // failure — the boundary is visual, so it cannot be forgotten.
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                    {groups.map((group) => (
                        <TabConsoleCard
                            key={group.tabId ?? 'unattributed'}
                            group={group}
                            onSend={send}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
