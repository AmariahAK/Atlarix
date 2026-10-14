import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { cn } from "@/lib/utils";

/**
 * A marketplace server's icon. Main fetches and checks it and hands back a
 * `data:` URL (src/lib/mcp/mcp-icons.ts); it is only ever an `<img>`. No icon
 * found: the first letter of its title.
 */
export function McpServerIcon({
  name,
  title,
  size = 32,
  className,
}: {
  name: string;
  title: string;
  size?: number;
  className?: string;
}) {
  const { data } = useQuery({
    queryKey: ["mcp-catalog", "icon", name],
    queryFn: () => IpcClient.getInstance().getMcpCatalogIcon(name),
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
      style={box}
      className={cn(
        "shrink-0 rounded-md bg-muted text-muted-foreground inline-flex items-center justify-center font-medium",
        className,
      )}
    >
      {(title.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
