/**
 * `glob` — find files by name pattern (v13; replaces find_file and the
 * list_files/explore_folder/get_project_structure family for discovery).
 * Results are modification-time sorted (newest first), like opencode/Claude Code.
 *
 * Backed by ripgrep (`rg --files -g <pattern>`), the SAME engine as `grep`: it
 * honors .gitignore/.ignore/.atlarixignore natively (see ripgrep-ignore.ts), so
 * node_modules/dist/.git never reach the model without any bespoke ignore code.
 */

import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fsp from "fs/promises";
import {
    ToolRegistry,
    createParameters,
    stringParam,
    numberParam,
} from "./registry";
import {
    resolvePathUnderWorkspace,
    resolveToolTargetPath,
    stripToolPathPrefixes,
} from "../../ipc/utils/safeWorkspaceRelativePath";
import { ripgrepIgnoreArgs } from "./ripgrep-ignore";
import { resolveRipgrepPath } from "./resolve-ripgrep";

const execFileAsync = promisify(execFile);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Move a leading DIRECTORY prefix out of the pattern and into the search path, so
 * `glob("../telios/**\/*.go")` means what it obviously means.
 *
 * Only a prefix that is unambiguously a location is absorbed: a run of leading
 * `../` segments, or an absolute path, up to the first segment containing a glob
 * metacharacter. `src/**\/*.ts` is untouched — a workspace-relative pattern is a
 * pattern, and ripgrep already handles it.
 *
 * An explicit `path` argument WINS: the caller said where to look, so a directory
 * prefix in the pattern is left alone rather than silently retargeting the search.
 *
 * `p` is the path flavour, injectable ONLY so both platforms can be tested from
 * one machine. It defaults to the running platform's and nothing passes it in
 * production. The Windows drive-letter bug this function used to have was
 * unreachable from a macOS or Linux test — `path.isAbsolute("C:\\x")` is false
 * there, so the broken branch never ran — and it therefore survived until a
 * tagged build put it on a Windows runner.
 */
export function absorbPatternDirectoryPrefix(
    pattern: string,
    searchPath: string,
    p: path.PlatformPath = path,
): { pattern: string; searchPath: string } {
    const trimmed = (pattern ?? "").trim();
    const callerGavePath = (searchPath ?? "").trim() !== "" && searchPath !== ".";
    if (callerGavePath || !trimmed) return { pattern, searchPath };

    const isAbsolute = p.isAbsolute(trimmed);
    const startsWithParent = /^\.\.[\\/]/.test(trimmed);
    if (!isAbsolute && !startsWithParent) return { pattern, searchPath };

    // Take the ROOT from the platform rather than assuming one leading separator.
    //
    // The old rebuild was `path.sep + segments.join(path.sep)`, which is right on
    // POSIX — splitting `/Users/me/x` drops an empty leading segment that has to be
    // put back — and wrong on Windows, where there is no empty leading segment to
    // restore. `C:\proj\sibling\**\*.go` came back as `\C:\proj\sibling`, a path
    // that does not exist, so ripgrep failed to start and `glob` returned
    // "glob failed to run the pattern" for every absolute pattern on Windows.
    // `path.parse().root` is `/` there and `C:\` here, which is exactly the
    // difference the old line was papering over.
    const root = isAbsolute ? p.parse(trimmed).root : "";
    const segments = trimmed
        .slice(root.length)
        .split(/[\\/]+/)
        .filter((s) => s !== "");
    const dirSegments: string[] = [];
    let i = 0;
    for (; i < segments.length; i++) {
        // Stop at the first segment that is a pattern rather than a directory name.
        if (/[*?[\]{}]/.test(segments[i])) break;
        dirSegments.push(segments[i]);
    }
    if (dirSegments.length === 0) return { pattern, searchPath };

    // `path.join` on the root keeps the platform's own separator rules — including
    // a UNC root, where naive concatenation loses a leading slash.
    const dir = isAbsolute
        ? p.join(root, ...dirSegments)
        : dirSegments.join("/");
    const remainder = segments.slice(i).join("/");

    // Nothing left to match on (e.g. `../telios`) → list that directory, which is
    // already the documented "bare directory listing" form of this tool.
    return { pattern: remainder || "*", searchPath: dir };
}

ToolRegistry.register({
    name: "glob",
    description:
        "Find files by glob pattern (e.g. '**/*.ts', 'src/**/auth*'). Returns workspace-relative paths sorted by modification time (newest first). " +
        "Use this for file discovery; use grep to search file CONTENTS. A bare directory listing is `glob` with pattern '*' and a path.",
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    allowInAskMode: true,
    parameters: createParameters(
        {
            pattern: stringParam(
                "Glob pattern (e.g. '**/*.tsx', 'component*', 'src/**')",
            ),
            path: stringParam("Folder to search in — defaults to the workspace root. To search outside the workspace, give its ABSOLUTE path."),
            limit: numberParam(
                `Max files returned (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
                DEFAULT_LIMIT,
                1,
                MAX_LIMIT,
            ),
        },
        ["pattern"],
    ),
    handler: async ({
        pattern,
        path: searchPath = ".",
        limit,
        workspace,
    }: {
        pattern: string;
        path?: string;
        limit?: number;
        workspace?: string;
    }) => {
        const max = Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
        // A `../…` or absolute DIRECTORY prefix in the pattern is absorbed into
        // `path` rather than refused.
        //
        // The old A18/L-3 guard rejected any `..` in the pattern, on the reasoning
        // that it would escape a confined `searchPath`. `searchPath` is no longer
        // confined — an absolute or `../` path searches where it says, because reads
        // are auto-allowed anywhere — so the guard was defending a boundary that had
        // already, deliberately, moved. What it still did was fail the single most
        // natural way to ask the question (`glob("../telios/*")`), with a message
        // telling the model to "use a path within the project" and never mentioning
        // the `path` parameter that would have worked. Observed cost: the model
        // abandoned the tool and went to `pwd`/`ls`/`find`, then guessed the wrong
        // directory. Absorb the alias; don't prompt against it.
        const absorbed = absorbPatternDirectoryPrefix(pattern, searchPath);
        const effectivePattern = absorbed.pattern;
        const effectiveSearchPath = absorbed.searchPath;
        try {
            // An absolute `path` — or a relative one written with `../` — searches
            // that exact location; reads are auto-allowed outside the workspace.
            // Everything else stays confined under the workspace.
            //
            // `../sibling` used to fail outright here, which is what sent an agent
            // asked to look at a neighbouring project through `pwd`, `ls ..` and a
            // `find` to rediscover a path it was always permitted to read. The
            // boundary is where the path lands, not how it was spelled.
            const usesParentTraversal =
                /^\.\.[\\/]/.test(effectiveSearchPath) || effectiveSearchPath === "..";
            const fullPath =
                path.isAbsolute(effectiveSearchPath) || usesParentTraversal
                    ? resolveToolTargetPath(workspace || process.cwd(), effectiveSearchPath).absPath
                    : workspace
                      ? resolvePathUnderWorkspace(workspace, effectiveSearchPath || ".")
                      : path.resolve(stripToolPathPrefixes(effectiveSearchPath || ".") || ".");

            // ripgrep lists files under cwd (paths relative to it), filtered by
            // .gitignore/.ignore/.atlarixignore. A CATCH-ALL `-g` glob (`*`, `**`,
            // `**/*`) makes ripgrep override those ignores and re-include
            // node_modules/dist — so for the universal patterns we pass NO `-g`
            // (plain `rg --files` is already correctly ignore-filtered) and, for a
            // bare `*`, keep only top-level entries (matching the old glob's
            // non-recursive `*` semantics). Constrained patterns respect ignores.
            const trimmed = effectivePattern.trim();
            const isUniversal =
                trimmed === "" ||
                trimmed === "*" ||
                trimmed === "**" ||
                trimmed === "**/*";
            const ignoreArgs = await ripgrepIgnoreArgs(workspace);
            const rgArgs = ["--files", ...ignoreArgs];
            if (!isUniversal) rgArgs.push("-g", effectivePattern);
            let matched: string[] = [];
            try {
                const { stdout } = await execFileAsync(await resolveRipgrepPath(), rgArgs, {
                    cwd: fullPath,
                    maxBuffer: 20 * 1024 * 1024,
                });
                matched = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
            } catch (e) {
                // ripgrep --files exits 1 when NOTHING matches (not an error) but
                // 2 on a real failure (e.g. a malformed glob like an unbalanced
                // '['). Only the former is "no files"; surface the latter so the
                // model fixes the pattern instead of trusting an empty result.
                const err = e as { code?: number; stderr?: string };
                if (err.code === 1) {
                    matched = [];
                } else {
                    const msg = (err.stderr || "").trim().split("\n")[0];
                    throw new Error(
                        msg ? `Invalid glob pattern: ${msg}` : "glob failed to run the pattern",
                    );
                }
            }
            if (trimmed === "*") {
                // Bare `*` = list this directory's own files, not the whole tree.
                matched = matched.filter((f) => !f.includes("/"));
            }

            // Like opencode / Claude Code, in-workspace files (incl. .env) are
            // enumerable — the agent works over the whole project.
            const files = matched;

            if (files.length === 0) {
                // Report what was actually searched, not just what was asked. When a
                // directory prefix was absorbed out of the pattern, saying only
                // "no files matching ../telios/*.go" leaves the model unable to tell
                // whether the directory or the pattern was wrong.
                const searchedNote =
                    effectivePattern !== pattern
                        ? ` (searched "${effectivePattern}" under ${fullPath})`
                        : "";
                return `No files found matching pattern: ${pattern}${searchedNote}. Often an extension or casing issue — try a broader glob (e.g. "**/${effectivePattern}"), or use grep to find the file by its content.`;
            }

            // Modification-time sort, newest first (recently-touched files are
            // usually what the task is about).
            const withMtime = await Promise.all(
                files.map(async (f) => {
                    try {
                        const st = await fsp.stat(path.join(fullPath, f));
                        return { f, m: st.mtimeMs };
                    } catch {
                        return { f, m: 0 };
                    }
                }),
            );
            withMtime.sort((a, b) => b.m - a.m);
            const kept = withMtime.slice(0, max).map((e) => e.f);
            const truncatedNote =
                withMtime.length > max
                    ? `\n… ${withMtime.length - max} more matched — narrow the pattern or raise limit.`
                    : "";

            return `Found ${withMtime.length} file(s) (newest first):\n${kept.join("\n")}${truncatedNote}`;
        } catch (error) {
            throw new Error(`Failed to find files: ${error}`);
        }
    },
});
