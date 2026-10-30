/**
 * What mods show in the app: a status chip per mod, toasts, and panes — small
 * cards that stay beside the chat until the mod or the person closes them.
 *
 * A pane is drawn from the mod's `ui.render` tree, which the main process has
 * already cut down to four element types (Box, Text, Button, List) with plain
 * text: nothing here renders HTML or a link from a mod. A Button sends its
 * `action` back to the mod and the pane is drawn again.
 */
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import type { ModNode, ModUiEvent } from "@/lib/plugins/mod-host";
import { showInfo } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface Pane {
  plugin: string;
  id: string;
  title: string;
  tree: ModNode | null;
}

const key = (plugin: string, id: string) => `${plugin}\u0000${id}`;

export function ModNodeView({
  node,
  onAction,
}: {
  node: ModNode;
  onAction: (action: string) => void;
}) {
  const children = node.children?.map((c, i) => (
    <ModNodeView key={i} node={c} onAction={onAction} />
  ));
  const tone =
    node.props?.tone === "muted"
      ? "text-muted-foreground"
      : node.props?.tone === "accent"
        ? "text-primary"
        : node.props?.tone === "warn"
          ? "text-amber-600 dark:text-amber-400"
          : "";
  switch (node.type) {
    case "Text":
      return (
        <div className={cn("text-sm whitespace-pre-wrap break-words", tone)}>
          {node.props?.text ?? ""}
        </div>
      );
    case "Button":
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={!node.props?.action}
          onClick={() => node.props?.action && onAction(node.props.action)}
        >
          {node.props?.text ?? ""}
        </Button>
      );
    case "List":
      return <div className="space-y-1">{children}</div>;
    default:
      return (
        <div
          className={cn(
            "flex gap-2",
            node.props?.direction === "row"
              ? "flex-row flex-wrap items-center"
              : "flex-col",
          )}
        >
          {node.props?.text ? (
            <div className={cn("text-sm", tone)}>{node.props.text}</div>
          ) : null}
          {children}
        </div>
      );
  }
}

export function ModUiLayer() {
  const ipc = IpcClient.getInstance();
  const workspacePath = useAtomValue(selectedWorkspaceInfoAtom)?.path ?? null;
  const [status, setStatus] = useState<Record<string, string>>({});
  const [panes, setPanes] = useState<Pane[]>([]);

  const draw = useCallback(
    async (plugin: string, id: string) => {
      const tree = await ipc
        .renderModPane(plugin, id, workspacePath)
        .catch(() => null);
      setPanes((ps) =>
        ps.map((p) =>
          key(p.plugin, p.id) === key(plugin, id) ? { ...p, tree } : p,
        ),
      );
    },
    [ipc, workspacePath],
  );

  useEffect(() => {
    // Panes opened before this window: MERGED, since an "open" event may have
    // arrived while this was in flight.
    void ipc.openModPanes().then((open) => {
      setPanes((ps) => [
        ...ps,
        ...open
          .filter(
            (o) => !ps.some((p) => key(p.plugin, p.id) === key(o.plugin, o.id)),
          )
          .map((o) => ({ ...o, tree: null })),
      ]);
      for (const p of open) void draw(p.plugin, p.id);
    });
    return ipc.onModUi((e: ModUiEvent) => {
      switch (e.kind) {
        case "status":
          setStatus((s) => {
            const next = { ...s };
            if (e.text) next[e.plugin] = e.text;
            else delete next[e.plugin];
            return next;
          });
          return;
        case "toast":
          return void showInfo(`${e.plugin}: ${e.text}`);
        case "open":
          setPanes((ps) =>
            ps.some((p) => key(p.plugin, p.id) === key(e.plugin, e.id))
              ? ps
              : [
                  ...ps,
                  { plugin: e.plugin, id: e.id, title: e.title, tree: null },
                ],
          );
          return void draw(e.plugin, e.id);
        case "redraw":
          // The mod handled something: what its panes show may have changed.
          setPanes((ps) => {
            for (const p of ps)
              if (p.plugin === e.plugin) void draw(p.plugin, p.id);
            return ps;
          });
          return;
        case "close":
          return setPanes((ps) =>
            ps.filter((p) => key(p.plugin, p.id) !== key(e.plugin, e.id)),
          );
        case "off":
          setPanes((ps) => ps.filter((p) => p.plugin !== e.plugin));
          setStatus((s) => {
            const next = { ...s };
            delete next[e.plugin];
            return next;
          });
          return void showInfo(`${e.plugin}'s mod is off: ${e.reason}`);
      }
    });
  }, [ipc, draw]);

  const statuses = Object.entries(status);
  if (!statuses.length && !panes.length) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex max-w-sm flex-col items-end gap-2">
      {panes.map((p) => (
        <div
          key={key(p.plugin, p.id)}
          className="pointer-events-auto w-80 rounded-lg border bg-background p-3 shadow-md"
          aria-label={`${p.title} (${p.plugin})`}
        >
          <div className="mb-2 flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-sm font-medium">
              {p.title}
            </div>
            <span className="text-xs text-muted-foreground">{p.plugin}</span>
            <button
              type="button"
              aria-label={`Close ${p.title}`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() =>
                setPanes((ps) =>
                  ps.filter((x) => key(x.plugin, x.id) !== key(p.plugin, p.id)),
                )
              }
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {p.tree ? (
            <ModNodeView
              node={p.tree}
              onAction={(action) =>
                void ipc
                  .modAction(p.plugin, action, workspacePath, p.id)
                  .then(() => draw(p.plugin, p.id))
              }
            />
          ) : null}
        </div>
      ))}
      {statuses.length ? (
        <div className="pointer-events-auto flex flex-wrap justify-end gap-1">
          {statuses.map(([plugin, text]) => (
            <span
              key={plugin}
              className="rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground"
              title={plugin}
            >
              {text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
