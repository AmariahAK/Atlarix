/**
 * `relic` — a page the agent makes to SHARE: a design to agree on before
 * building, an explainer, a report. Like an artifact: one relic per thing,
 * updated in place as it changes.
 *
 * Where it goes (src/lib/relics/hosting-tier.ts):
 * - paid Atlarix Core → hosted, private, at https://atlarix.dev/r/<id>
 *   (published through the Supabase `relics` function; files in R2);
 * - your own API keys, or free Atlarix Auto → a folder in the workspace,
 *   `.atlarix/relics/<slug>/`, to open or send as a file.
 *
 * Files are checked by the same rules the server applies
 * (supabase/functions/_shared/relic-files.ts): an index.html, at most 50 files
 * and 5 MB, plain relative paths, web file types.
 */
import fs from "node:fs";
import path from "node:path";
import { ToolRegistry } from "./registry";
import { relicHostingForChat } from "@/lib/relics/hosting-tier";
import { prepareRelicFiles, type RelicFileIn } from "../../../supabase/functions/_shared/relic-files";

type RelicArgs = {
  operation?: "create" | "update";
  id?: string;
  title?: string;
  kind?: "page" | "design";
  files?: RelicFileIn[];
  /** Shorthand for a one-file relic: becomes index.html. */
  html?: string;
  workspace?: string;
  _chatSessionId?: number;
};

export interface RelicResult {
  success: boolean;
  hosted?: boolean;
  id?: string;
  title?: string;
  kind?: "page" | "design";
  url?: string;
  path?: string;
  version?: number;
  note?: string;
  error?: string;
}

const LOCAL_PREFIX = "local:";

export function relicSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "relic"
  );
}

/** Write a relic's files under `<workspace>/.atlarix/relics/<slug>/`, replacing an earlier version. */
export function writeLocalRelic(
  workspace: string,
  slug: string,
  files: Array<{ path: string; bytes: Uint8Array }>,
): string {
  const root = path.join(workspace, ".atlarix", "relics");
  const dir = path.join(root, slug);
  if (!dir.startsWith(root + path.sep)) throw new Error("Bad relic name.");
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const dest = path.join(dir, f.path);
    if (!dest.startsWith(dir + path.sep)) throw new Error(`Bad path: ${f.path}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.bytes);
  }
  return path.join(dir, "index.html");
}

async function publishHosted(body: Record<string, unknown>): Promise<{ id: string; url: string; version: number } | { error: string; code?: string }> {
  const { getSupabaseClient } = await import("@/lib/auth/supabase-client");
  const { data, error } = await getSupabaseClient().functions.invoke("relics", { body });
  if (error) {
    let msg = error.message;
    let code: string | undefined;
    try {
      const ctx = (error as { context?: Response }).context;
      const j = ctx ? ((await ctx.json()) as { error?: string; code?: string }) : null;
      if (j?.error) msg = j.error;
      code = j?.code;
    } catch {
      /* keep the SDK's message */
    }
    return { error: msg, code };
  }
  return data as { id: string; url: string; version: number };
}

export async function runRelic(args: RelicArgs): Promise<RelicResult> {
  const title = String(args.title ?? "").trim();
  const files: RelicFileIn[] = Array.isArray(args.files) && args.files.length
    ? args.files
    : typeof args.html === "string"
      ? [{ path: "index.html", content: args.html }]
      : [];
  const kind = args.kind === "design" ? "design" : "page";
  const prepared = prepareRelicFiles(files);
  if ("error" in prepared) return { success: false, error: prepared.error };
  const id = args.id?.trim() || undefined;
  if (!title && !id) return { success: false, error: "A relic needs a title." };

  const isLocalId = id?.startsWith(LOCAL_PREFIX);
  const hosting = isLocalId ? { hosted: false as const, reason: "it was made as a local file" } : await relicHostingForChat(args._chatSessionId);

  if (hosting.hosted) {
    const res = await publishHosted({ action: "publish", id, title: title || undefined, kind, files });
    if (!("error" in res)) {
      return {
        success: true,
        hosted: true,
        id: res.id,
        title,
        kind,
        url: res.url,
        version: res.version,
        note: "Published privately. Only the user can open it until they share it (Share on the page, or /relics).",
      };
    }
    if (res.code !== "not_paid") return { success: false, error: res.error };
    // The server says not paid: fall through to a local file, and say so.
  }

  const workspace = args.workspace;
  if (!workspace) return { success: false, error: "A local relic needs an open workspace folder." };
  const slug = isLocalId ? id!.slice(LOCAL_PREFIX.length) : relicSlug(title);
  const index = writeLocalRelic(workspace, slug, prepared.files);
  return {
    success: true,
    hosted: false,
    id: LOCAL_PREFIX + slug,
    title: title || slug,
    kind,
    path: index,
    note:
      `Saved as a local file (${hosting.hosted ? "hosting needs paid Atlarix Core" : hosting.reason}): ` +
      `${path.relative(workspace, index)}. The user can open it in a browser or send the folder. ` +
      "With paid Atlarix Core, relics are hosted with a private link instead.",
  };
}

ToolRegistry.register({
  name: "relic",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: false,
  description:
    "Make or update a RELIC: a self-contained web page to share with the user — a design to agree on BEFORE building, an explainer, a report, a visual summary. " +
    "Pass `title` and the page as `html` (one file) or `files` ([{path, content}], must include index.html; images as base64 with encoding:\"base64\"). " +
    "`kind: \"design\"` shows it on a pannable canvas. To change it later, call again with the returned `id` (one relic per thing, updated in place — never a new one per edit). " +
    "On paid Atlarix Core it is hosted privately at an atlarix.dev link; otherwise it is saved in the workspace under .atlarix/relics/. Tell the user the link or path. " +
    "Self-contained only: inline CSS/JS or public CDNs; the page cannot make network requests. Never put secrets or credentials in a relic.",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["create", "update"], description: "create (default) or update (with id)." },
      id: { type: "string", description: "The relic to update (from an earlier call)." },
      title: { type: "string", description: "Short name shown above the page." },
      kind: { type: "string", enum: ["page", "design"], description: "page (default) or design (boards on a canvas)." },
      html: { type: "string", description: "The whole page, for a one-file relic (becomes index.html)." },
      files: {
        type: "array",
        description: "Several files; must include index.html. Relative paths only.",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            encoding: { type: "string", enum: ["utf8", "base64"] },
          },
          required: ["path", "content"],
        },
      },
    },
  },
  handler: async (args: RelicArgs) => runRelic(args),
});
