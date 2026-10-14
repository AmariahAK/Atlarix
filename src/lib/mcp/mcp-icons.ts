/**
 * Marketplace icons, fetched and checked in the main process.
 *
 * A registry icon is a URL anyone can publish. It is never loaded by the page:
 * main fetches it (size-capped, raster or a script-free SVG only), caches it
 * under `<userData>/cache/mcp-icons/`, and the card gets a `data:` URL, which
 * is always rendered as an `<img>` (an SVG there cannot run anything) and never
 * inlined. No icon: the server's website favicon, then its address's site
 * favicon, then the card draws a letter.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getUserDataPath } from "@/paths/paths";
import { getMcpCatalogEntry } from "./registry-catalog";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;
const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "image/vnd.microsoft.icon"]);
/** How long a "no icon here" answer is remembered before trying again. */
const MISS_TTL_MS = 24 * 60 * 60 * 1000;

const memory = new Map<string, string | null>();

function cacheDir(): string {
  return path.join(getUserDataPath(), "cache", "mcp-icons");
}

function keyFor(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 32);
}

/** An SVG is accepted only when it can do nothing but draw. */
export function isSafeSvg(text: string): boolean {
  return !(
    /<script[\s>]/i.test(text) ||
    /<foreignObject[\s>]/i.test(text) ||
    /\son[a-z]+\s*=/i.test(text) ||
    /(?:xlink:)?href\s*=\s*["']\s*(?!#)/i.test(text) ||
    /javascript:/i.test(text) ||
    /<!ENTITY/i.test(text)
  );
}

function sniffMime(bytes: Buffer, declared: string | null): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return declared && RASTER.has(declared) ? declared : null;
}

/** Fetch one candidate and return it as a data URL, or null. */
export async function fetchIconAsDataUrl(url: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "Atlarix/1.0" } });
    if (!res.ok) return null;
    const declared = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    const mime = sniffMime(bytes, declared);
    if (!mime) return null;
    if (mime === "image/svg+xml" && !isSafeSvg(bytes.toString("utf8"))) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function apexOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.split(".");
    const apex = host.length > 2 ? host.slice(-2).join(".") : host.join(".");
    return `https://${apex}`;
  } catch {
    return null;
  }
}

function candidatesFor(entry: {
  icons: Array<{ src: string; mimeType?: string }>;
  websiteUrl?: string;
  options: Array<{ kind: string; url?: string }>;
}): string[] {
  const out: string[] = [];
  // Raster first: they need no checking beyond the type.
  const icons = [...entry.icons].sort(
    (a, b) => Number(a.mimeType === "image/svg+xml") - Number(b.mimeType === "image/svg+xml"),
  );
  for (const i of icons) out.push(i.src);
  if (entry.websiteUrl) {
    try {
      out.push(`${new URL(entry.websiteUrl).origin}/favicon.ico`);
    } catch {
      /* not a URL */
    }
  }
  const remote = entry.options.find((o) => o.kind === "web")?.url;
  const apex = apexOrigin(remote) ?? apexOrigin(entry.websiteUrl);
  if (apex) out.push(`${apex}/favicon.ico`);
  return [...new Set(out)];
}

/** The icon for a marketplace server as a data URL, or null for the letter avatar. */
export async function getMcpIcon(name: string): Promise<string | null> {
  if (memory.has(name)) return memory.get(name) ?? null;
  const file = path.join(cacheDir(), keyFor(name));
  try {
    const stat = await fs.stat(file);
    const text = await fs.readFile(file, "utf8");
    if (text === "" && Date.now() - stat.mtimeMs < MISS_TTL_MS) {
      memory.set(name, null);
      return null;
    }
    if (text.startsWith("data:")) {
      memory.set(name, text);
      return text;
    }
  } catch {
    // Not cached yet.
  }
  const entry = await getMcpCatalogEntry(name);
  let found: string | null = null;
  if (entry) {
    for (const c of candidatesFor(entry)) {
      found = await fetchIconAsDataUrl(c);
      if (found) break;
    }
  }
  memory.set(name, found);
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(file, found ?? "", "utf8");
  } catch {
    // A cache that can't be written only costs a refetch.
  }
  return found;
}
