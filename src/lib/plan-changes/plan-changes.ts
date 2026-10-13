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

export function parsePlanChangesFromContent(
  content: string,
): PlanChangesPayload | null {
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

/** Words that say a file mentioned in a plan is not going to change. */
const NOT_CHANGING_RE = new RegExp(
  [
    "no changes? (?:needed|required)",
    "no (?:edits?|changes?) (?:to|in)",
    "unchanged",
    "untouched",
    "not (?:be )?(?:changed|modified|touched|edited)",
    "(?:won'?t|will not|don'?t|do not) (?:touch|change|modify|edit)",
    "stays? as[- ]is",
    "leave .{0,80}? (?:as[- ]is|alone)",
    "doesn'?t need (?:a )?changes?",
  ]
    .map((p) => `\\b${p}\\b`)
    .join("|"),
  "i",
);

const PATH_EXT =
  "ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|md|json|yaml|yml|toml|sql|css|scss|html|vue|svelte";

/**
 * Heuristic: pull `path/to/file.ext` from plan step lines. Plans usually write
 * paths as code (`src/a.ts`); a step that ADDS or CREATES a path ("Add
 * `bin/cli.js`") lists it as created.
 */
export function deriveFilesFromPlanMarkdown(
  planMd: string,
): PlanChangesPayload["files"] {
  const seen = new Set<string>();
  const out: PlanChangesPayload["files"] = [];
  const pathRe = new RegExp(
    `(?:^|[\\s(\`'"])([\\w@./-]+\\.(?:${PATH_EXT}))(?=[\\s),.:;\`'"]|$)`,
    "gi",
  );
  const createRe = new RegExp(
    `^\\s*(?:[-*]|\\d+[.)])?\\s*(?:\\[[ xX]\\]\\s*)?(?:add|create|new)\\s+[\`'"]?([\\w@./-]+\\.(?:${PATH_EXT}))`,
    "i",
  );
  for (const rawLine of planMd.split("\n")) {
    // "(README.md is a one-liner; no change needed.)" names a file that is NOT
    // changing (QA #35): a parenthesis or sentence that says so is skipped.
    const line = rawLine
      .replace(/\([^)]*\)/g, (p) => (NOT_CHANGING_RE.test(p) ? " " : p))
      .split(/(?<=[.;])\s+/)
      .filter((sentence) => !NOT_CHANGING_RE.test(sentence))
      .join(" ");
    const created = createRe.exec(line)?.[1]?.replace(/^\.?\//, "");
    let m: RegExpExecArray | null;
    pathRe.lastIndex = 0;
    while ((m = pathRe.exec(line)) !== null) {
      const path = m[1].replace(/^\.?\//, "");
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, action: path === created ? "CREATE" : "MODIFY" });
    }
  }
  return out;
}

function proposalAction(operation: string): PlanFileAction {
  return operation === "create"
    ? "CREATE"
    : operation === "delete"
      ? "DELETE"
      : "MODIFY";
}

/**
 * What the Plan panel lists under "What's changing", each file once: the
 * model's own changes comment if it wrote one; otherwise the files the plan
 * names, plus any the pending approvals touch beyond them. It used to take the
 * approvals alone whenever there were any — one row per edit, the same file
 * three times — and drop what the plan said it would create (QA #15).
 */
export function resolvePlanChanges(
  messages: ReadonlyArray<{ role: string; content: string }>,
  markdown: string | null,
  proposals: ReadonlyArray<{ path: string; operation: string }>,
): PlanChangesPayload | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const parsed = parsePlanChangesFromContent(m.content);
    if (parsed) return parsed;
  }
  const files = markdown ? deriveFilesFromPlanMarkdown(markdown) : [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const p of proposals) {
    const path = p.path?.trim();
    if (!path) continue;
    const action = proposalAction(p.operation);
    const known = byPath.get(path);
    if (!known) {
      const row = { path, action };
      byPath.set(path, row);
      files.push(row);
    } else if (known.action === "MODIFY" && action !== "MODIFY") {
      known.action = action;
    }
  }
  return files.length ? { files } : null;
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
