/**
 * Your relics, for the app's Relics tab and the CLI's /relics: one
 * implementation for both.
 *
 * - Hosted (paid Core, signed in): listed, shared and deleted through the
 *   `relics` edge function. Offline, signed out, or before the service exists,
 *   the hosted half is simply empty.
 * - Local (your own keys, free Auto): `<workspace>/.atlarix/relics/<slug>/index.html`.
 *   Deleting one removes only a folder under a workspace's `.atlarix/relics/`.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeAppPath } from "@/lib/canonical-app-path";

export interface RelicSummary {
  id: string;
  title: string;
  kind: "page" | "design";
  hosted: boolean;
  /** Hosted: the atlarix.dev link. */
  url?: string;
  /** Local: the index.html on disk. */
  path?: string;
  visibility?: "private" | "link";
  updatedAt: number;
}

export type RelicVisibility = "private" | "link";

/** This workspace's local relics: each `.atlarix/relics/<slug>/index.html`, titled by its <title>. */
export function listLocalRelics(workspaceDir: string): RelicSummary[] {
  const root = path.join(workspaceDir, ".atlarix", "relics");
  const out: RelicSummary[] = [];
  for (const slug of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const index = path.join(root, slug, "index.html");
    if (!fs.existsSync(index)) continue;
    const html = fs.readFileSync(index, "utf8").slice(0, 4000);
    const title = /<title>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim() || slug;
    out.push({ id: `local:${slug}`, title, kind: "page", hosted: false, path: index, updatedAt: fs.statSync(index).mtimeMs });
  }
  return out;
}

async function relicsFunction(body: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
  const { getSupabaseClient } = await import("@/lib/auth/supabase-client");
  return getSupabaseClient().functions.invoke("relics", { body });
}

/** Your hosted relics, or none (signed out, offline, or the service isn't there). */
export async function listHostedRelics(): Promise<RelicSummary[]> {
  try {
    const { getSession } = await import("@/lib/auth/supabase-client");
    if (!(await getSession())) return [];
    const { data } = await relicsFunction({ action: "list" });
    return ((data as { relics?: Array<Record<string, unknown>> } | null)?.relics ?? []).map((r) => ({
      id: String(r.id),
      title: String(r.title ?? r.id),
      kind: r.kind === "design" ? "design" : "page",
      hosted: true,
      url: String(r.url),
      visibility: r.visibility === "link" ? "link" : "private",
      updatedAt: new Date(String(r.updated_at)).getTime(),
    }));
  } catch {
    return [];
  }
}

/** Hosted and this workspace's local relics, newest first. */
export async function listRelics(workspaceDir: string): Promise<RelicSummary[]> {
  const [hosted, local] = [await listHostedRelics(), listLocalRelics(workspaceDir)];
  return [...hosted, ...local].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * `file` is a relic's index.html directly in a slug folder of one of these
 * workspaces' `.atlarix/relics/` (case-insensitive where the file system is).
 * The preview reads only such a file, and delete removes only its folder.
 */
export function isLocalRelicPath(file: string, workspaces: string[]): boolean {
  const resolved = normalizeAppPath(file);
  if (path.basename(resolved) !== "index.html") return false;
  return workspaces.some((ws) => {
    const root = normalizeAppPath(path.join(ws, ".atlarix", "relics"));
    const rel = path.relative(root, resolved);
    // Exactly <root>/<slug>/index.html: never the folder itself, never above it.
    return !rel.startsWith("..") && !path.isAbsolute(rel) && rel.split(path.sep).length === 2;
  });
}

/** Delete a relic: hosted through the service; local only inside a known workspace's relics folder. */
export async function removeRelic(relic: Pick<RelicSummary, "id" | "hosted" | "path">, workspaces: string[]): Promise<void> {
  if (relic.hosted) {
    const { error } = await relicsFunction({ action: "delete", id: relic.id });
    if (error) throw new Error("Couldn't delete it. Try again.");
    return;
  }
  if (!relic.path || !isLocalRelicPath(relic.path, workspaces)) throw new Error("That isn't one of this workspace's relics.");
  fs.rmSync(path.dirname(path.resolve(relic.path)), { recursive: true, force: true });
}

/** Private (only you, signed in) or anyone with the link. */
export async function setRelicVisibility(id: string, visibility: RelicVisibility): Promise<void> {
  const { error } = await relicsFunction({ action: "set-visibility", id, visibility });
  if (error) throw new Error("Couldn't change sharing. Try again.");
}
