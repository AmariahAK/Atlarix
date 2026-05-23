import React from "react";
import { McpToolMessageCard } from "./McpToolMessageCard";

interface AtlarixMcpToolCallProps {
  node?: { properties?: { serverName?: string; toolName?: string } };
  children?: React.ReactNode;
}

export const AtlarixMcpToolCall: React.FC<AtlarixMcpToolCallProps> = ({
  node,
  children,
}) => (
  <McpToolMessageCard
    kind="call"
    serverName={node?.properties?.serverName || ""}
    toolName={node?.properties?.toolName || ""}
  >
    {children}
  </McpToolMessageCard>
);
