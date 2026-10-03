/**
 * What a relic may contain, checked before anything is stored. Pure, so the
 * edge function and the app share one rule and vitest pins it.
 */
export const RELIC_LIMITS = {
  maxFiles: 50,
  maxBytes: 5 * 1024 * 1024,
  maxRelicsPerUser: 200,
  maxTitle: 200,
} as const;

export interface RelicFileIn {
  path: string;
  content: string;
  /** "base64" for binary files (images); text otherwise. */
  encoding?: "utf8" | "base64";
}

export interface RelicFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  woff2: "font/woff2",
};

export function contentTypeFor(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? null;
}

/** A safe relative path: no `..`, no leading slash, plain characters. */
export function cleanRelicPath(path: string): string | null {
  const p = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.length > 200 || p.startsWith("/")) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(p)) return null;
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return p;
}

function decodeBase64(s: string): Uint8Array {
  const b = atob(s);
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** The files to store, or the reason they can't be. Needs an index.html. */
export function prepareRelicFiles(files: unknown): { files: RelicFile[]; bytes: number } | { error: string } {
  if (!Array.isArray(files) || files.length === 0) return { error: "A relic needs at least one file (index.html)." };
  if (files.length > RELIC_LIMITS.maxFiles) return { error: `A relic can hold at most ${RELIC_LIMITS.maxFiles} files.` };
  const out: RelicFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files as RelicFileIn[]) {
    const path = typeof f?.path === "string" ? cleanRelicPath(f.path) : null;
    if (!path) return { error: `Not a usable file path: ${JSON.stringify(f?.path)}` };
    if (seen.has(path)) return { error: `${path} appears twice.` };
    seen.add(path);
    const type = contentTypeFor(path);
    if (!type) return { error: `${path}: that kind of file can't go in a relic.` };
    if (typeof f.content !== "string") return { error: `${path} has no content.` };
    let bytes: Uint8Array;
    try {
      bytes = f.encoding === "base64" ? decodeBase64(f.content) : new TextEncoder().encode(f.content);
    } catch {
      return { error: `${path}: the base64 content doesn't decode.` };
    }
    total += bytes.length;
    if (total > RELIC_LIMITS.maxBytes) return { error: `A relic can be at most ${RELIC_LIMITS.maxBytes / 1024 / 1024} MB.` };
    out.push({ path, bytes, contentType: type });
  }
  if (!seen.has("index.html")) return { error: "A relic needs an index.html." };
  return { files: out, bytes: total };
}

/** A new relic id: short, unguessable, URL-safe. */
export function newRelicId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return "rl_" + Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 20);
}
