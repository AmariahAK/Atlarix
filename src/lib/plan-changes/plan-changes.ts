export type PlanFileAction = "CREATE" | "MODIFY" | "ADD" | "DELETE";

export type PlanChangesPayload = {
  files: Array<{ path: string; action: PlanFileAction }>;
  risks?: string[];
};

const CHANGES_COMMENT_RE = /<!--\s*atlarix-changes:\s*([\s\S]*?)\s*-->/i;

const ACTION_ALIASES: Record<string, PlanFileAction> = {
  CREATE: "CREATE",
  MODIFY: "MODIFY",
  ADD: "ADD",
  DELETE: "DELETE",
  NEW: "CREATE",
  UPDATE: "MODIFY",
  EDIT: "MODIFY",
  REMOVE: "DELETE",
};

function normalizeAction(raw: string): PlanFileAction {
  const key = raw.trim().toUpperCase();
  return ACTION_ALIASES[key] ?? "MODIFY";
}

export function parsePlanChangesFromContent(content: string): PlanChangesPayload | null {
  const m = content.match(CHANGES_COMMENT_RE);
  if (!m?.[1]) return null;
  try {
    const data = JSON.parse(m[1].trim()) as Record<string, unknown>;
    const filesRaw = data.files;
    if (!Array.isArray(filesRaw)) return null;
    const files = filesRaw
      .map((f) => {
        if (!f || typeof f !== "object") return null;
        const row = f as Record<string, unknown>;
        const path = String(row.path ?? "").trim();
        if (!path) return null;
        return {
          path,
          action: normalizeAction(String(row.action ?? "MODIFY")),
        };
      })
      .filter((x): x is { path: string; action: PlanFileAction } => x != null);
    const risks = Array.isArray(data.risks)
      ? data.risks.map((r) => String(r).trim()).filter(Boolean)
      : undefined;
    if (files.length === 0) return null;
    return { files, risks };
  } catch {
    return null;
  }
}

/** Heuristic: pull `path/to/file.ext` from plan step lines. */
export function deriveFilesFromPlanMarkdown(planMd: string): PlanChangesPayload["files"] {
  const seen = new Set<string>();
  const out: PlanChangesPayload["files"] = [];
  const re =
    /(?:^|[\s(])([\w@./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|swift|md|json|yaml|yml|sql|css|scss|html|vue|svelte))(?:[\s),.:]|$)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(planMd)) !== null) {
    const path = m[1].replace(/^\.?\//, "");
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, action: "MODIFY" });
  }
  return out;
}

export function stripPlanChangesComment(content: string): string {
  return content.replace(CHANGES_COMMENT_RE, "").trim();
}

export function groupChangesByAction(
  files: PlanChangesPayload["files"],
): Record<PlanFileAction, string[]> {
  const groups: Record<PlanFileAction, string[]> = {
    CREATE: [],
    MODIFY: [],
    ADD: [],
    DELETE: [],
  };
  for (const f of files) {
    groups[f.action].push(f.path);
  }
  return groups;
}
