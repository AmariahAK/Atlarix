/**
 * WorkspaceFileTree - IDE-style file tree for sidebar
 * Single-click to expand folders, click file → opens in Code tab
 */

import React, { useState } from "react";
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

interface WorkspaceFileTreeProps {
  files: string[];
  onFileClick: (path: string) => void;
  maxHeight?: string;
}

export function WorkspaceFileTree({
  files,
  onFileClick,
  maxHeight = "160px",
}: WorkspaceFileTreeProps) {
  const tree = buildTree(files);
  if (tree.length === 0) return null;

  return (
    <div
      className="overflow-y-auto border-b border-border/50"
      style={{ maxHeight }}
    >
      <TreeLevel nodes={tree} level={0} onFileClick={onFileClick} />
    </div>
  );
}

function TreeLevel({
  nodes,
  level,
  onFileClick,
}: {
  nodes: TreeNode[];
  level: number;
  onFileClick: (path: string) => void;
}) {
  return (
    <ul className={cn("pl-2", level > 0 && "ml-3 border-l border-border/30")}>
      {sortNodes(nodes).map((node) => (
        <TreeNodeComp
          key={node.path}
          node={node}
          level={level}
          onFileClick={onFileClick}
        />
      ))}
    </ul>
  );
}

function TreeNodeComp({
  node,
  level,
  onFileClick,
}: {
  node: TreeNode;
  level: number;
  onFileClick: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(level < 2);

  if (node.isDirectory) {
    return (
      <li className="py-0.5">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "flex items-center gap-1.5 w-full text-left px-1.5 py-1 rounded text-xs",
            "hover:bg-accent/50 text-muted-foreground hover:text-foreground"
          )}
        >
          {expanded ? (
            <FolderOpen className="h-3 w-3 flex-shrink-0 text-amber-500" />
          ) : (
            <Folder className="h-3 w-3 flex-shrink-0 text-amber-500" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children.length > 0 && (
          <TreeLevel
            nodes={node.children}
            level={level + 1}
            onFileClick={onFileClick}
          />
        )}
      </li>
    );
  }

  return (
    <li className="py-0.5">
      <button
        type="button"
        onClick={() => onFileClick(node.path)}
        className={cn(
          "flex items-center gap-1.5 w-full text-left px-1.5 py-1 rounded text-xs",
          "hover:bg-accent/50 text-muted-foreground hover:text-foreground"
        )}
      >
        <FileCode2 className="h-3 w-3 flex-shrink-0 text-blue-500" />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}
