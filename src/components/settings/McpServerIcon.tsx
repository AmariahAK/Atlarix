import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { cn } from "@/lib/utils";

/** What a stored server knows about itself; main finds its logo from it. */
export interface McpIconRef {
  registryName?: string | null;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
}

/**
 * An MCP server's logo, wherever a server is shown. Main fetches and checks it
 * and hands back a `data:` URL (src/lib/mcp/mcp-icons.ts); it is only ever an
 * `<img>`. No logo found: the first letter of its title.
 *
 * Ask by one of: `name` (a registry name, the marketplace), `iconRef` (an added
 * server's registry name, URL or command), or `serverName` (a configured
 * server as the agent names it, e.g. an MCP tool row).
 */
export function McpServerIcon({
  name,
  iconRef,
  serverName,
  appId = null,
  title,
  size = 32,
  className,
}: {
  name?: string;
  iconRef?: McpIconRef;
  serverName?: string;
  appId?: number | null;
  title: string;
  size?: number;
  className?: string;
}) {
  const ipc = IpcClient.getInstance();
  const { data } = useQuery({
    queryKey: ["mcp-catalog", "icon", name ?? null, iconRef ?? null, serverName ?? null, serverName ? appId : null],
    queryFn: () =>
      name
        ? ipc.getMcpCatalogIcon(name)
        : iconRef
          ? ipc.getMcpIconFor(iconRef)
          : serverName
            ? ipc.getMcpServerIcon(appId, serverName)
            : Promise.resolve(null),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });
  const box = { width: size, height: size };
  if (data) {
    return (
      <img
        src={data}
        alt=""
        style={box}
        className={cn("shrink-0 rounded-md object-contain", className)}
        draggable={false}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.45)) }}
      className={cn(
        "shrink-0 rounded-md bg-muted text-muted-foreground inline-flex items-center justify-center font-medium",
        className,
      )}
    >
      {(title.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
