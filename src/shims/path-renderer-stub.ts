/**
 * Renderer-safe path helpers (no Node `path` module in the bundle).
 */
import { basenameFromPath } from "@/lib/path-basename";

export function basename(filePath: string): string {
  return basenameFromPath(filePath);
}

export function extname(filePath: string): string {
  const base = basenameFromPath(filePath);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot);
}

export function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized.startsWith("/") ? "/" : ".";
  return normalized.slice(0, idx) || "/";
}

export function join(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
}

export default { basename, extname, dirname, join };
