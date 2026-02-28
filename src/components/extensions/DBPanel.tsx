/**
 * DB Studio — Left panel extension. Schema tree, table view, query editor.
 */

import { useState, useEffect, useCallback } from "react";
import { Database, ChevronRight, ChevronDown, Circle, Loader2 } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DBConnectionSummary {
  id: string;
  name: string;
  type: string;
  status: "connected" | "disconnected" | "error";
  isProd?: boolean;
}

export interface DBSchemaSummary {
  tables: { name: string; columns: { name: string; type: string }[] }[];
  foreignKeys: { table: string; column: string; referencedTable: string; referencedColumn: string }[];
}

export interface DBPanelProps {
  workspaceId: number | null;
}

export function DBPanel({ workspaceId }: DBPanelProps) {
  const [connections, setConnections] = useState<DBConnectionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [schema, setSchema] = useState<DBSchemaSummary | null>(null);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<unknown[] | null>(null);
  const [query, setQuery] = useState("");
  const [queryResults, setQueryResults] = useState<unknown[] | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);

  const client = IpcClient.getInstance();

  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.dbListConnections(workspaceId);
      const conns = (res?.connections ?? []) as DBConnectionSummary[];
      setConnections(conns);
      setActiveId(res?.activeId ?? null);
    } catch {
      setConnections([]);
      setActiveId(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const loadSchema = useCallback(async () => {
    if (workspaceId === null) return;
    setSchemaLoading(true);
    try {
      const s = await client.dbGetSchema(workspaceId);
      setSchema(s ?? null);
    } catch {
      setSchema(null);
    } finally {
      setSchemaLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    if (activeId) loadSchema();
    else setSchema(null);
  }, [activeId, loadSchema]);

  useEffect(() => {
    if (!selectedTable || workspaceId === null) {
      setTableData(null);
      return;
    }
    let cancelled = false;
    setTableData(null);
    client.dbGetTableData(workspaceId, selectedTable).then((res) => {
      if (!cancelled && res?.rows) setTableData(res.rows);
    }).catch(() => {
      if (!cancelled) setTableData([]);
    });
    return () => { cancelled = true; };
  }, [workspaceId, selectedTable]);

  const runQuery = useCallback(async () => {
    if (workspaceId === null || !query.trim()) return;
    setQueryError(null);
    setQueryResults(null);
    try {
      const res = await client.dbRunQuery(workspaceId, query.trim());
      if (res?.error) setQueryError(res.error);
      else setQueryResults(res?.rows ?? []);
    } catch (e) {
      setQueryError(String(e));
    }
  }, [workspaceId, query]);

  const toggleTable = (name: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const activeConn = connections.find((c) => c.id === activeId);
  const isConnected = activeConn?.status === "connected";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <Database className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium text-sm">DB Studio</span>
        {activeConn && (
          <span
            className={cn(
              "flex items-center gap-1 text-xs",
              isConnected ? "text-green-600" : "text-muted-foreground"
            )}
          >
            <Circle className={cn("h-1.5 w-1.5 fill-current", isConnected && "text-green-600")} />
            {activeConn.name}
          </span>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading connections…
            </div>
          ) : connections.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No database connections. Add one in Settings or via the extension manager.
            </p>
          ) : (
            <>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Schema</p>
                {schemaLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading…
                  </div>
                ) : schema && schema.tables.length > 0 ? (
                  <div className="space-y-0.5">
                    {schema.tables.map((t) => (
                      <div key={t.name}>
                        <button
                          type="button"
                          className={cn(
                            "flex items-center gap-1 w-full text-left text-xs py-0.5 px-1 rounded",
                            selectedTable === t.name && "bg-sidebar-accent"
                          )}
                          onClick={() => {
                            toggleTable(t.name);
                            setSelectedTable(t.name);
                          }}
                        >
                          {expandedTables.has(t.name) ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {t.name}
                        </button>
                        {expandedTables.has(t.name) && (
                          <div className="pl-4 text-[11px] text-muted-foreground">
                            {t.columns.map((c) => (
                              <div key={c.name}>
                                {c.name}: {c.type}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No tables or not connected.</p>
                )}
              </div>

              {selectedTable && tableData !== null && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Table: {selectedTable}</p>
                  <div className="rounded border border-border overflow-auto max-h-48">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="bg-muted/50">
                          {tableData.length > 0 &&
                            Object.keys(tableData[0] as object).map((k) => (
                              <th key={k} className="text-left p-1 border-b border-border">
                                {k}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tableData.slice(0, 50).map((row, i) => (
                          <tr key={i}>
                            {Object.values(row as object).map((v, j) => (
                              <td key={j} className="p-1 border-b border-border/50 truncate max-w-[120px]">
                                {String(v ?? "")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {tableData.length > 50 && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">Showing first 50 rows.</p>
                  )}
                </div>
              )}

              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Query</p>
                <textarea
                  className="w-full h-20 rounded border border-border bg-background px-2 py-1.5 text-xs font-mono resize-none"
                  placeholder="SELECT * FROM ..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Button size="sm" className="mt-1" onClick={runQuery} disabled={!isConnected}>
                  Run
                </Button>
                {queryError && (
                  <p className="text-xs text-destructive mt-1">{queryError}</p>
                )}
                {queryResults && (
                  <div className="mt-2 rounded border border-border overflow-auto max-h-40">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="bg-muted/50">
                          {queryResults.length > 0 &&
                            Object.keys(queryResults[0] as object).map((k) => (
                              <th key={k} className="text-left p-1 border-b border-border">
                                {k}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queryResults.slice(0, 100).map((row, i) => (
                          <tr key={i}>
                            {Object.values(row as object).map((v, j) => (
                              <td key={j} className="p-1 border-b border-border/50 truncate max-w-[100px]">
                                {String(v ?? "")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
