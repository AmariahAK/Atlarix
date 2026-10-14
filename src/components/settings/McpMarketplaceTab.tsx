/**
 * The MCP marketplace: the official MCP Registry, cached and searched in main
 * (src/lib/mcp/registry-catalog.ts), with the Verified servers first.
 *
 * Every card says who published it: the Verified badge for the base set,
 * otherwise the registry namespace (`io.github.someone`), so a user can see who
 * they are trusting. Web servers go on the account (every surface, Chrome
 * included); local ones are added to this folder.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, ExternalLink, Loader2, Search } from "lucide-react";
import { showError } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IpcClient } from "@/ipc/ipc_client";
import type { CatalogEntry, CatalogOption } from "@/shared/mcp-catalog";
import { McpServerIcon } from "./McpServerIcon";
import { useMcpAddFlow } from "./useMcpAddFlow";

const PAGE_SIZE = 6;

function optionLabel(o: CatalogOption): string {
  if (o.kind === "web") {
    try {
      return new URL(o.url.replace(/\{[^}]+\}/g, "x")).host;
    } catch {
      return "Web";
    }
  }
  return `${o.registryType} · ${o.identifier}`;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function McpMarketplaceTab({ workspaceId }: { workspaceId: number }) {
  const ipc = IpcClient.getInstance();
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 200);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ entry: CatalogEntry; optionId: string; values: Record<string, string> } | null>(null);
  const { finish, dialog: secretDialog } = useMcpAddFlow(workspaceId);

  useEffect(() => setPage(0), [query]);

  const results = useQuery({
    queryKey: ["mcp-catalog", "search", query, page, workspaceId],
    queryFn: () => ipc.searchMcpCatalog({ query, offset: page * PAGE_SIZE, limit: PAGE_SIZE, appId: workspaceId }),
    placeholderData: (prev) => prev,
  });
  const limit = useQuery({
    queryKey: ["mcp", "limit", workspaceId],
    queryFn: () => ipc.getMcpLimit(workspaceId),
  });

  const installed = useMemo(() => new Set(results.data?.installed ?? []), [results.data]);
  const totalPages = Math.max(1, Math.ceil((results.data?.total ?? 0) / PAGE_SIZE));

  const install = async (entry: CatalogEntry, optionId: string, values: Record<string, string>) => {
    setAdding(entry.name);
    try {
      const added = await ipc.installMcpFromCatalog({ appId: workspaceId, name: entry.name, optionId, values });
      setDialog(null);
      await finish([added]);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(null);
    }
  };

  const onAdd = (entry: CatalogEntry) => {
    const usable = entry.options.filter((o) => o.kind === "web" || o.supported);
    const first = usable[0];
    if (!first) return;
    // One click when there is nothing to choose and nothing to fill in.
    if (usable.length === 1 && first.inputs.length === 0) {
      void install(entry, first.id, {});
      return;
    }
    setDialog({ entry, optionId: first.id, values: {} });
  };

  const option = dialog?.entry.options.find((o) => o.id === dialog.optionId);

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search MCP servers"
          className="pl-8"
        />
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {(results.data?.total ?? 0).toLocaleString()} servers
          {limit.data ? ` · ${limit.data.on}/${limit.data.max} on` : ""}
        </span>
        {totalPages > 1 && (
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              Prev
            </Button>
            {page + 1} / {totalPages}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page + 1 >= totalPages}
            >
              Next
            </Button>
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(results.data?.entries ?? []).map((entry) => {
          const isAdded = installed.has(entry.name);
          const link = entry.websiteUrl ?? entry.repositoryUrl;
          return (
            <div key={entry.name} className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
              <div className="flex items-start gap-3">
                <McpServerIcon name={entry.name} title={entry.title} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate">{entry.title}</span>
                    {entry.verified && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-primary shrink-0">
                        <BadgeCheck className="h-3.5 w-3.5" />
                        Verified
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                    {!entry.verified && <span className="font-mono truncate">{entry.publisher}</span>}
                    <span className="rounded bg-muted/60 px-1.5 py-0.5 shrink-0">
                      {entry.kind === "web" ? "Web" : "Local"}
                    </span>
                  </div>
                </div>
                {link && (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`${entry.title} website`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
              {entry.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{entry.description}</p>
              )}
              <Button
                size="sm"
                variant={isAdded ? "outline" : "default"}
                className="w-full mt-auto"
                disabled={isAdded || adding != null || !entry.installable}
                onClick={() => onAdd(entry)}
              >
                {adding === entry.name ? <Loader2 className="h-4 w-4 animate-spin" /> : isAdded ? "Added" : "Add"}
              </Button>
            </div>
          );
        })}
      </div>

      {results.data && results.data.entries.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">No servers match.</p>
      )}

      <Dialog open={dialog != null} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog && option && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <McpServerIcon name={dialog.entry.name} title={dialog.entry.title} size={24} />
                {dialog.entry.title}
              </DialogTitle>
              <DialogDescription>
                {dialog.entry.verified ? "Verified" : dialog.entry.publisher}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              {dialog.entry.options.filter((o) => o.kind === "web" || o.supported).length > 1 && (
                <div className="space-y-1">
                  <Label className="text-xs">Run</Label>
                  <select
                    value={dialog.optionId}
                    onChange={(e) => setDialog({ ...dialog, optionId: e.target.value, values: {} })}
                    className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
                  >
                    {dialog.entry.options
                      .filter((o) => o.kind === "web" || o.supported)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.kind === "web" ? "Web" : "Local"} · {optionLabel(o)}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              {option.inputs.map((input) => (
                <div key={input.key} className="space-y-1">
                  <Label htmlFor={`mcp-in-${input.key}`} className="text-xs">
                    {input.label}
                    {!input.required && <span className="text-muted-foreground"> (optional)</span>}
                  </Label>
                  {input.choices?.length ? (
                    <select
                      id={`mcp-in-${input.key}`}
                      value={dialog.values[input.key] ?? input.default ?? ""}
                      onChange={(e) =>
                        setDialog({ ...dialog, values: { ...dialog.values, [input.key]: e.target.value } })
                      }
                      className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
                    >
                      {input.choices.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`mcp-in-${input.key}`}
                      type={input.secret ? "password" : "text"}
                      value={dialog.values[input.key] ?? ""}
                      placeholder={input.placeholder ?? input.default ?? ""}
                      onChange={(e) =>
                        setDialog({ ...dialog, values: { ...dialog.values, [input.key]: e.target.value } })
                      }
                    />
                  )}
                  {input.description && input.description !== input.label && (
                    <p className="text-[11px] text-muted-foreground">{input.description}</p>
                  )}
                </div>
              ))}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setDialog(null)} disabled={adding != null}>
                Cancel
              </Button>
              <Button
                onClick={() => void install(dialog.entry, dialog.optionId, dialog.values)}
                disabled={
                  adding != null ||
                  option.inputs.some(
                    (i) => i.required && !(dialog.values[i.key] ?? "").trim() && i.default === undefined,
                  )
                }
              >
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
      {secretDialog}
    </div>
  );
}
