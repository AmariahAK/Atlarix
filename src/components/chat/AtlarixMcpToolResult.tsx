import React from "react";
import { McpToolMessageCard } from "./McpToolMessageCard";

interface AtlarixMcpToolResultProps {
  node?: { properties?: { serverName?: string; toolName?: string } };
  children?: React.ReactNode;
}

export const AtlarixMcpToolResult: React.FC<AtlarixMcpToolResultProps> = ({
  node,
  children,
}) => (
  <McpToolMessageCard
    kind="result"
    serverName={node?.properties?.serverName || ""}
    toolName={node?.properties?.toolName || ""}
  >
    {children}
  </McpToolMessageCard>
);
