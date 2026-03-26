/**
 * Compact blueprint text for chat system prompts (token-bounded).
 * Prefer `buildBlueprintSystemPromptInjection` in blueprintPromptTiers for v5.0 tiered injection.
 */
import type { Blueprint } from "@/shared/blueprint-types";
import { formatBlueprintAskTierLegacy } from "@/lib/blueprint/blueprintPromptTiers";

const DEFAULT_MAX_CHARS = 6000;

export function formatBlueprintForPrompt(
  blueprint: Blueprint,
  maxChars: number = DEFAULT_MAX_CHARS,
  /** When set, resolves beacon file paths relative to the workspace (Ask-tier formatting). */
  workspaceRoot?: string,
): string {
  if (workspaceRoot) {
    const maxTokens = Math.max(200, Math.floor(maxChars / 4));
    return formatBlueprintAskTierLegacy(blueprint, workspaceRoot, maxTokens);
  }

  const rooms = blueprint?.rooms ?? [];
  const edges = blueprint?.edges ?? [];
  if (rooms.length === 0 && edges.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(
    "Architecture blueprint (same graph as the Diagram tab). Use read_file/search_code for source details.",
  );

  const MAX_ROOMS = 14;
  const MAX_FUNCS_PER_ROOM = 10;
  const MAX_EDGES = 30;

  for (const room of rooms.slice(0, MAX_ROOMS)) {
    const fnNames = (room.functions ?? [])
      .slice(0, MAX_FUNCS_PER_ROOM)
      .map((f) => f.name)
      .join(", ");
    const more =
      (room.functions?.length ?? 0) > MAX_FUNCS_PER_ROOM
        ? ` (+${(room.functions?.length ?? 0) - MAX_FUNCS_PER_ROOM} more)`
        : "";
    const pathPart = room.path ? ` [${room.path}]` : "";
    lines.push(`- **${room.label}** (${room.id})${pathPart}: ${fnNames || "(no beacons)"}${more}`);
  }
  if (rooms.length > MAX_ROOMS) {
    lines.push(`- … +${rooms.length - MAX_ROOMS} more rooms`);
  }

  if (edges.length > 0) {
    lines.push("");
    lines.push("Cross-room edges:");
    for (const e of edges.slice(0, MAX_EDGES)) {
      const lbl = e.label ? ` — ${e.label}` : "";
      lines.push(`  - ${e.from} → ${e.to}${lbl}`);
    }
    if (edges.length > MAX_EDGES) {
      lines.push(`  - … +${edges.length - MAX_EDGES} more edges`);
    }
  }

  if (blueprint.envRefs?.length) {
    lines.push("");
    lines.push(`Env keys referenced (names only): ${blueprint.envRefs.slice(0, 20).join(", ")}`);
  }

  let out = lines.join("\n");
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 24)}\n\n…(blueprint truncated)`;
  }
  return out;
}
