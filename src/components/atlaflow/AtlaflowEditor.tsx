/**
 * Atlaflow Editor - Visual workflow builder with ReactFlow
 * Phase 2: Native Workflow Builder
 * - Drag nodes from palette
 * - Connect nodes
 * - Export/Import n8n JSON
 */

import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  Controls,
  Background,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { AtlaflowNode } from "./AtlaflowNode";
import { ATLAFLOW_NODE_LIBRARY } from "./ATLAFLOW_NODES";
import { workflowToReactFlow, reactFlowToWorkflow } from "@/lib/workflow/atlaflow_converter";
import type { AtlaflowWorkflow } from "@/lib/workflow/atlaflow_converter";
import { Sparkles, Download, Upload } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const nodeTypes = { atlaflowNode: AtlaflowNode };

interface AtlaflowEditorProps {
  initialWorkflow: AtlaflowWorkflow | null;
  onExport: (workflow: AtlaflowWorkflow) => void;
  onGenerateCode: (workflow: AtlaflowWorkflow) => void;
  onImportSuccess?: () => void;
}

function AtlaflowEditorInner({
  initialWorkflow,
  onExport,
  onGenerateCode,
  onImportSuccess,
}: AtlaflowEditorProps) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const { initialNodes, initialEdges } = useMemo(() => {
    if (initialWorkflow?.nodes?.length) {
      const { nodes, edges } = workflowToReactFlow(initialWorkflow);
      return { initialNodes: nodes, initialEdges: edges };
    }
    return { initialNodes: [], initialEdges: [] };
  }, [initialWorkflow]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const onConnect = useCallback(
    (conn: Connection) => setEdges((eds) => addEdge(conn, eds)),
    [setEdges]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const nodeType = e.dataTransfer.getData("application/atlaflow-node");
      if (!nodeType) return;

      const def = ATLAFLOW_NODE_LIBRARY.find((n) => n.type === nodeType);
      if (!def) return;

      const bounds = (e.target as HTMLElement).getBoundingClientRect();
      const x = e.clientX - bounds.left - 60;
      const y = e.clientY - bounds.top - 20;

      const newNode: Node = {
        id: `node-${Date.now()}`,
        type: "atlaflowNode",
        position: { x, y },
        data: {
          label: def.label,
          nodeType: def.type,
          parameters: {},
        },
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes]
  );

  const getCurrentWorkflow = useCallback(
    () => reactFlowToWorkflow(nodes, edges),
    [nodes, edges]
  );

  const handleExport = useCallback(() => {
    onExport(getCurrentWorkflow());
  }, [getCurrentWorkflow, onExport]);

  const handleGenerateCode = useCallback(() => {
    onGenerateCode(getCurrentWorkflow());
  }, [getCurrentWorkflow, onGenerateCode]);

  const handleImport = useCallback(() => {
    try {
      const parsed = JSON.parse(importText) as AtlaflowWorkflow;
      if (!parsed.nodes || !Array.isArray(parsed.nodes)) throw new Error("Invalid format");
      const { nodes: newNodes, edges: newEdges } = workflowToReactFlow(parsed);
      setNodes(newNodes);
      setEdges(newEdges);
      setShowImport(false);
      setImportText("");
      toast.success("Atlaflow loaded.");
      onImportSuccess?.();
    } catch (e) {
      toast.error("Invalid JSON. Expected { nodes: [...], connections: {...} }");
    }
  }, [importText, setNodes, setEdges, onImportSuccess]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/20">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Paste JSON to load workflow"
          >
            <Upload className="w-3.5 h-3.5" />
            Import JSON
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Copy JSON to clipboard"
          >
            <Download className="w-3.5 h-3.5" />
            Export JSON
          </button>
          <button
            onClick={handleGenerateCode}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Generate Code
          </button>
        </div>
      </div>

      {/* Selected node: details (functions, classes) for module nodes + message to AI */}
      {selectedNodeId && (() => {
        const sel = nodes.find((n) => n.id === selectedNodeId);
        const data = sel?.data as { nodeType?: string; parameters?: { functions?: string[]; classes?: string[]; files?: string[]; filePath?: string }; message?: string } | undefined;
        const isModule = data?.nodeType === "atlaflow.module";
        const params = data?.parameters ?? {};
        const functions = (params.functions as string[] | undefined) ?? [];
        const classes = (params.classes as string[] | undefined) ?? [];
        const files = (params.files as string[] | undefined) ?? [];
        const filePath = params.filePath as string | undefined;
        return (
        <div className="px-3 py-2 border-b border-border/60 bg-muted/10 flex flex-col gap-2">
          {isModule && (functions.length > 0 || classes.length > 0 || files.length > 0 || filePath) && (
            <div className="text-xs text-muted-foreground space-y-1">
              {(filePath || files.length > 0) && (
                <p className="font-medium text-foreground/90">Files</p>
              )}
              {filePath && <div className="font-mono truncate">{filePath}</div>}
              {files.length > 0 && <div className="font-mono flex flex-wrap gap-1">{files.slice(0, 6).map((f) => <span key={f} className="px-1 rounded bg-muted">{f}</span>)}{files.length > 6 ? ` +${files.length - 6}` : ""}</div>}
              {functions.length > 0 && (
                <>
                  <p className="font-medium text-foreground/90 mt-1">Functions</p>
                  <div className="flex flex-wrap gap-1">{functions.slice(0, 12).map((fn) => <span key={fn} className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">{fn}()</span>)}{functions.length > 12 ? ` +${functions.length - 12}` : ""}</div>
                </>
              )}
              {classes.length > 0 && (
                <>
                  <p className="font-medium text-foreground/90 mt-1">Classes</p>
                  <div className="flex flex-wrap gap-1">{classes.slice(0, 8).map((cl) => <span key={cl} className="px-1.5 py-0.5 rounded bg-muted">{cl}</span>)}{classes.length > 8 ? ` +${classes.length - 8}` : ""}</div>
                </>
              )}
            </div>
          )}
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground mb-1">
              Message to AI for selected node
            </p>
            <textarea
              className="w-full text-xs rounded-md border border-border bg-background px-2 py-1 resize-y min-h-[40px]"
              placeholder='e.g. "Later, add PayPal and LemonSqueezy support as alternatives to Stripe."'
              value={
                (() => {
                  const n = nodes.find((node) => node.id === selectedNodeId);
                  const data = n?.data as { message?: string } | undefined;
                  return data?.message ?? "";
                })()
              }
              onChange={(e) => {
                const value = e.target.value;
                setNodes((current) =>
                  current.map((n) =>
                    n.id === selectedNodeId
                      ? {
                          ...n,
                          data: {
                            ...(n.data ?? {}),
                            message: value,
                          },
                        }
                      : n,
                  ),
                );
              }}
            />
          </div>
        </div>
        );
      })()}

      {/* Import modal */}
      {showImport && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="w-[90%] max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
            <p className="text-sm font-medium mb-2">Paste Atlaflow / n8n JSON</p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='{"nodes": [...], "connections": {...}}'
              className="w-full h-32 rounded-md border border-border bg-muted/30 p-2 text-xs font-mono resize-none"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => { setShowImport(false); setImportText(""); }}
                className="px-3 py-1.5 text-xs rounded-md text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Load
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Node palette */}
        <div className="w-40 flex-shrink-0 border-r border-border overflow-y-auto p-2 space-y-3">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Nodes
          </p>
          {(["trigger", "data", "action", "app"] as const).map((cat) => (
            <div key={cat}>
              <p className="text-[10px] text-muted-foreground/80 mb-1 capitalize">{cat}</p>
              <div className="space-y-0.5">
                {ATLAFLOW_NODE_LIBRARY.filter((n) => n.category === cat).map((node) => (
                  <div
                    key={node.type}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/atlaflow-node", node.type);
                    }}
                    className={cn(
                      "px-2 py-1.5 text-xs rounded-md cursor-grab active:cursor-grabbing",
                      "bg-muted/50 hover:bg-muted border border-transparent hover:border-border"
                    )}
                  >
                    {node.label}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Canvas (scrollable vertically if workflow is tall) */}
        <div className="flex-1 min-h-0 relative overflow-auto">
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[1]">
              <div className="text-center max-w-sm px-4 py-6 rounded-lg bg-background/80 border border-border shadow-sm">
                <p className="text-sm font-medium text-foreground mb-1">No workflow yet</p>
                <p className="text-xs text-muted-foreground">
                  Drag nodes from the left, use <strong>Import JSON</strong>, or ask the AI to generate code from a workflow in chat.
                </p>
              </div>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            nodeTypes={nodeTypes}
            fitView
            className="bg-muted/5"
          >
            <Controls
              className="atlaflow-controls-theme"
            />
            <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}

export function AtlaflowEditor(props: AtlaflowEditorProps) {
  return (
    <ReactFlowProvider>
      <AtlaflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
