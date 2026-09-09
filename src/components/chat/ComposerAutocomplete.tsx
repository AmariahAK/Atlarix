/**
 * Composer autocomplete for `@` file/folder mentions (current workspace).
 *
 * Typing `@` lists files and folders in the current workspace (gitignore-aware via
 * `workspace:list-paths`). Picking a file inserts `@file:<relpath> ` (its contents
 * are injected at dispatch, capped); picking a folder inserts `@dir:<relpath> ` (only
 * the folder's file listing is injected, so the agent greps/reads within that scope).
 * This hook detects the `@` token under the caret, shows a list anchored above the
 * textarea, and inserts the exact token the dispatch understands. The list
 * intentionally does NOT take focus (plain div, not cmdk) so the textarea keeps focus
 * and arrow/enter/esc are routed through the composer's own `onKeyDown`.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { attachmentsAtom } from "@/atoms/chatAtoms";
import { mentionDisplayName } from "@/lib/chat/mention-attachment";
import { cn } from "@/lib/utils";

type Trigger = {
  query: string;
  start: number; // index where the `@` token begins
  end: number; // caret index (token end)
};

type Item = { id: string; label: string; detail: string; insert: string };

/** Find an `@word` token (at start or after whitespace) ending at the caret. Exported for tests. */
export function detectTrigger(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const m = /(^|\s)(@[^\s]*)$/.exec(before);
  if (!m) return null;
  const token = m[2];
  const start = caret - token.length;
  let query = token.slice(1);
  // Tolerate the explicit `file:`/`dir:` prefixes the user may already be typing.
  if (query.toLowerCase().startsWith("file:")) query = query.slice(5);
  else if (query.toLowerCase().startsWith("dir:")) query = query.slice(4);
  return { query, start, end: caret };
}

export function useComposerAutocomplete(opts: {
  value: string;
  setValue: (v: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * When true, a picked file/folder becomes a removable attachment chip (added
   * to the shared attachments atom) instead of inline `@file:`/`@dir:` text;
   * the token is re-emitted into the prompt at send. Composers that don't use
   * the attachments atom (e.g. the simple InputBar) leave this off and keep the
   * legacy inline-insert behavior.
   */
  mentionChips?: boolean;
}): {
  menu: React.ReactNode;
  /** Returns true if the keypress was consumed by the menu (caller should not submit). */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
} {
  const { value, setValue, textareaRef, mentionChips = false } = opts;
  const workspaceId = useAtomValue(selectedAppIdAtom);
  const setAttachments = useSetAtom(attachmentsAtom);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [index, setIndex] = useState(0);
  // Suppress reopening for the exact value the user dismissed with Esc.
  const dismissedForValue = useRef<string | null>(null);

  // The query is searched in MAIN (live ripgrep over every file) rather than
  // fetched once and filtered here — a pre-built list was capped at 4,000 paths,
  // so past that size files were unmentionable however you spelled them.
  // Debounced so a fast typist spawns one search, not one per keystroke; previous
  // results stay on screen while the next lands, so the menu never blanks.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const activeQuery = trigger?.query ?? "";
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(activeQuery), 100);
    return () => clearTimeout(t);
  }, [activeQuery]);

  const { data: paths } = useQuery({
    queryKey: ["workspacePaths", workspaceId, debouncedQuery],
    queryFn: () =>
      IpcClient.getInstance().listWorkspacePaths(workspaceId!, debouncedQuery),
    enabled: workspaceId != null && trigger != null,
    placeholderData: keepPreviousData,
  });

  // Recompute the active trigger from the live caret whenever the value changes.
  useEffect(() => {
    if (dismissedForValue.current === value) return;
    dismissedForValue.current = null;
    const caret = textareaRef.current?.selectionStart ?? value.length;
    setTrigger(detectTrigger(value, caret));
    setIndex(0);
  }, [value, textareaRef]);

  const items: Item[] = useMemo(() => {
    if (!trigger || !paths) return [];
    const q = trigger.query.toLowerCase();
    const dirItems: Item[] = paths.dirs
      .filter((d) => d.toLowerCase().includes(q))
      .slice(0, 4)
      .map((d) => ({
        id: `dir:${d}`,
        label: `${d}/`,
        detail: "folder — listing only (agent greps within)",
        insert: `@dir:${d} `,
      }));
    const fileItems: Item[] = paths.files
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 8 - dirItems.length)
      .map((f) => ({
        id: `file:${f}`,
        label: f,
        detail: "file — contents included",
        insert: `@file:${f} `,
      }));
    return [...dirItems, ...fileItems];
  }, [trigger, paths]);

  const open = trigger != null && items.length > 0;

  const select = (item: Item) => {
    if (!trigger) return;

    // Caret position after the edit (chip path strips the token; inline path
    // lands after the inserted text).
    let pos: number;
    if (mentionChips) {
      // Strip the in-progress `@…` token — the mention becomes a removable chip
      // added to the shared attachments atom instead of inline text. The
      // `@file:`/`@dir:` token is re-emitted into the prompt at send time, so
      // the existing scoped/capped extraction is unchanged.
      const next = value.slice(0, trigger.start) + value.slice(trigger.end);
      setValue(next);
      pos = trigger.start;

      const kind: "file" | "dir" = item.id.startsWith("dir:") ? "dir" : "file";
      const relpath = item.id.slice(kind.length + 1); // strip "dir:" / "file:"
      setAttachments((prev) => {
        if (
          prev.some(
            (a) => a.mention?.kind === kind && a.mention?.relpath === relpath,
          )
        ) {
          return prev; // already mentioned — no duplicate chip
        }
        return [
          ...prev,
          {
            type: "chat-context",
            id: crypto.randomUUID(),
            mention: {
              kind,
              relpath,
              displayName: mentionDisplayName(kind, relpath),
            },
          },
        ];
      });
    } else {
      // Legacy inline insert (composers without the attachments atom).
      const next =
        value.slice(0, trigger.start) + item.insert + value.slice(trigger.end);
      setValue(next);
      pos = trigger.start + item.insert.length;
    }

    setTrigger(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (i + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (i - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      select(items[Math.min(index, items.length - 1)]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissedForValue.current = value;
      setTrigger(null);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 w-72 max-w-[90%] overflow-hidden rounded-lg border border-border bg-popover shadow-md"
      role="listbox"
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Mention a file or folder
      </div>
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === index}
          // onMouseDown (not onClick) so the textarea doesn't blur before insert.
          onMouseDown={(e) => {
            e.preventDefault();
            select(item);
          }}
          onMouseEnter={() => setIndex(i)}
          className={cn(
            "flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left",
            i === index ? "bg-accent" : "hover:bg-accent/50",
          )}
        >
          <span className="text-sm font-medium truncate w-full">
            {item.label}
          </span>
          {item.detail ? (
            <span className="truncate text-xs text-muted-foreground w-full">
              {item.detail}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  ) : null;

  return { menu, onKeyDown };
}
