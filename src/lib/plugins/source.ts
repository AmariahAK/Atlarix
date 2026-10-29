/**
 * Where a plugin comes from, and getting its files into a staging folder.
 *
 * Two sources, both named by the person:
 * - GitHub: `https://github.com/owner/repo`, `…/tree/<ref>/<subdir>`, `owner/repo`,
 *   `owner/repo@ref`. Resolved to a commit SHA first, then that exact commit's
 *   archive is downloaded, so what is installed is what is pinned. Public
 *   repositories only; a private one is installed from a local clone.
 * - A local folder. Copied, never linked: editing the original later must not
 *   change an installed plugin behind the record's back.
 *
 * No `git` binary is needed (Windows machines often have none): the archive comes
 * from codeload and is unpacked with fflate, which the app already ships.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import type { PluginSource } from "./store";

export class PluginSourceError extends Error {}

const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const FETCH_TIMEOUT_MS = 60_000;

export function parsePluginSource(
  input: string,
  cwd = process.cwd(),
): PluginSource {
  const raw = input.trim();
  if (!raw) throw new PluginSourceError("Name a GitHub repository or a folder");

  if (
    raw.startsWith("~/") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    path.isAbsolute(raw)
  ) {
    const abs = raw.startsWith("~/")
      ? path.join(os.homedir(), raw.slice(2))
      : path.resolve(cwd, raw);
    return { kind: "local", path: abs };
  }

  const url = raw.replace(/^github:/, "");
  const web =
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(
      url,
    );
  if (web) return github(web[1]!, web[2]!, web[3], web[4]);

  const short = /^([^/@\s]+)\/([^/@\s]+?)(?:@([^/\s]+))?$/.exec(url);
  if (short) return github(short[1]!, short[2]!, short[3], undefined);

  if (fs.existsSync(path.resolve(cwd, raw)))
    return { kind: "local", path: path.resolve(cwd, raw) };
  throw new PluginSourceError(
    `"${raw}" is not a GitHub repository or a folder`,
  );
}

function github(
  owner: string,
  repo: string,
  ref?: string,
  subdir?: string,
): PluginSource {
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) {
    throw new PluginSourceError(
      `"${owner}/${repo}" is not a GitHub repository name`,
    );
  }
  if (ref && !/^[A-Za-z0-9_./-]+$/.test(ref))
    throw new PluginSourceError(`"${ref}" is not a branch, tag or commit`);
  const cleanSubdir = subdir?.split("/").filter(Boolean);
  if (cleanSubdir?.some((s) => s === ".." || s === ".")) {
    throw new PluginSourceError(
      `"${subdir}" is not a folder in the repository`,
    );
  }
  return {
    kind: "github",
    owner,
    repo,
    ref,
    subdir: cleanSubdir?.join("/") || undefined,
  };
}

export function describeSource(s: PluginSource): string {
  if (s.kind === "local") return s.path;
  const at = s.ref ? `@${s.ref}` : "";
  return `github.com/${s.owner}/${s.repo}${s.subdir ? `/${s.subdir}` : ""}${at}`;
}

/** The name a skills-only plugin gets when nothing in it names itself. */
export function defaultNameFor(s: PluginSource): string {
  const base =
    s.kind === "local"
      ? path.basename(s.path)
      : (s.subdir?.split("/").pop() ?? s.repo);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
}

/**
 * Put the plugin's files in `dest` (which must not exist). Returns the commit SHA
 * for a GitHub source.
 */
export async function fetchPluginSource(
  source: PluginSource,
  dest: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sha?: string }> {
  if (source.kind === "local") {
    const st = fs.statSync(source.path, { throwIfNoEntry: false });
    if (!st?.isDirectory())
      throw new PluginSourceError(`${source.path} is not a folder`);
    fs.cpSync(source.path, dest, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => path.basename(src) !== ".git",
    });
    return {};
  }

  const sha = await resolveCommit(source, fetchImpl);
  const res = await fetchImpl(
    `https://codeload.github.com/${source.owner}/${source.repo}/zip/${sha}`,
    {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new PluginSourceError(`Download failed (${res.status})`);
  const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));

  const prefix = source.subdir ? `${source.subdir}/` : "";
  let wrote = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const [entryName, data] of Object.entries(entries)) {
    // Every codeload archive has one top folder, `<repo>-<sha>/`.
    const rel = entryName.split("/").slice(1).join("/");
    if (!rel || rel.endsWith("/") || !rel.startsWith(prefix)) continue;
    const inside = rel.slice(prefix.length);
    const target = path.resolve(dest, inside);
    if (!target.startsWith(path.resolve(dest) + path.sep)) {
      throw new PluginSourceError(
        `Archive entry "${entryName}" points outside the plugin`,
      );
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    wrote++;
  }
  if (wrote === 0) {
    throw new PluginSourceError(
      source.subdir
        ? `Nothing in ${source.subdir} at ${sha.slice(0, 7)}`
        : "The repository is empty",
    );
  }
  return { sha };
}

async function resolveCommit(
  source: Extract<PluginSource, { kind: "github" }>,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (source.ref && /^[0-9a-f]{40}$/i.test(source.ref))
    return source.ref.toLowerCase();
  const ref = encodeURIComponent(source.ref ?? "HEAD");
  const res = await fetchImpl(
    `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${ref}`,
    {
      headers: {
        Accept: "application/vnd.github.sha",
        "User-Agent": "Atlarix",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (res.status === 404 || res.status === 422) {
    throw new PluginSourceError(
      `${describeSource(source)} was not found (a private repository? install it from a local clone)`,
    );
  }
  if (!res.ok) throw new PluginSourceError(`GitHub answered ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha))
    throw new PluginSourceError("GitHub did not return a commit");
  return sha.toLowerCase();
}
