/**
 * WorkspaceFileTree - IDE-style file tree (Code tab + full-screen code page)
 * Single-click to expand folders, click file → opens in Code tab.
 *
 * v10.1: virtualized — the tree used to mount a DOM node per file, which made
 * 10k+ file repos crawl. Expanded nodes flatten into rows rendered through
 * @tanstack/react-virtual (fixed ~26px rows).
 */

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Folder, FolderOpen, FileCode2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
}

function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const filePath of files) {
    const parts = filePath.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      const isDir = i < parts.length - 1;
      let node = current.find((n) => n.name === name);
      if (!node) {
        node = { name, path, isDirectory: isDir, children: [] };
        current.push(node);
      }
      current = node.children;
    }
  }
  return root;
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

const ROW_HEIGHT = 26;

interface FlatRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

interface WorkspaceFileTreeProps {
  files: string[];
  onFileClick: (path: string) => void;
  /** When set, scroll inside this box; when omitted, parent layout owns scrolling (better thumb sizing in sidebars). */
  maxHeight?: string;
}

export function WorkspaceFileTree({
  files,
  onFileClick,
  maxHeight,
}: WorkspaceFileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  // Folders default-expand two levels deep; user toggles override.
  const [expandOverrides, setExpandOverrides] = useState<Map<string, boolean>>(
    new Map(),
  );

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of sortNodes(nodes)) {
        const expanded =
          node.isDirectory && (expandOverrides.get(node.path) ?? depth < 2);
        out.push({ node, depth, expanded });
        if (expanded) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, expandOverrides]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (rows.length === 0) return null;

  const toggleDir = (path: string, currentlyExpanded: boolean) => {
    setExpandOverrides((prev) => {
      const next = new Map(prev);
      next.set(path, !currentlyExpanded);
      return next;
    });
  };

  return (
    <div
      ref={parentRef}
      className="border-b border-border/50 overflow-y-auto"
      style={{
        maxHeight: maxHeight ?? undefined,
        height: maxHeight != null ? "100%" : undefined,
      }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const { node, depth, expanded } = rows[vi.index];
          return (
            <div
              key={node.path}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <button
                type="button"
                onClick={() =>
                  node.isDirectory
                    ? toggleDir(node.path, expanded)
                    : onFileClick(node.path)
                }
                className={cn(
                  "flex items-center gap-1.5 w-full h-full text-left pr-1.5 rounded text-xs",
                  "hover:bg-accent/50 text-muted-foreground hover:text-foreground",
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
                title={node.path}
              >
                {node.isDirectory ? (
                  expanded ? (
                    <FolderOpen className="h-3 w-3 flex-shrink-0 text-amber-500" />
                  ) : (
                    <Folder className="h-3 w-3 flex-shrink-0 text-amber-500" />
                  )
                ) : (
                  <FileCode2 className="h-3 w-3 flex-shrink-0 text-blue-500" />
                )}
                <span className="truncate">{node.name}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
