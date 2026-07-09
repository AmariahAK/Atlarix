/**
 * `glob` — find files by name pattern (v13; replaces find_file and the
 * list_files/explore_folder/get_project_structure family for discovery).
 * Results are modification-time sorted (newest first), like opencode/Claude Code.
 */

import * as path from "path";
import * as fsp from "fs/promises";
import { glob as runGlob } from "glob";
import {
    ToolRegistry,
    createParameters,
    stringParam,
    numberParam,
} from "./registry";
import {
    resolvePathUnderWorkspace,
    stripToolPathPrefixes,
} from "../../ipc/utils/safeWorkspaceRelativePath";
import { isBlockedSecretBasename } from "@/lib/security/env-secret-paths";
import { loadIgnorerForProject, isRelPathIgnored } from "@/lib/atlarix/atlarix-ignore";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// Pruned during traversal so we never walk into heavy dirs (perf). Finer
// exclusions (.DS_Store, .vscode, .idea, user-defined) are applied afterward
// via the workspace .atlarixignore — the same rules Blueprint/RTE use.
const TRAVERSAL_PRUNE = [
    "node_modules/**",
    "**/node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    "out/**",
    "coverage/**",
    ".next/**",
    ".cache/**",
    ".turbo/**",
];

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
            path: stringParam("Folder to search in (default: workspace root)"),
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
        // A18/L-3: the glob library honors `../` in the PATTERN, so `../../*`
        // would enumerate outside the workspace even though `searchPath` is
        // confined. Reject any `..` path segment in the pattern.
        if (/(^|[\\/])\.\.([\\/]|$)/.test(pattern)) {
            return {
                success: false,
                error: "glob pattern may not contain '..' (it would escape the workspace). Use a path within the project.",
            };
        }
        try {
            const fullPath = workspace
                ? resolvePathUnderWorkspace(workspace, searchPath || ".")
                : path.resolve(stripToolPathPrefixes(searchPath || ".") || ".");
            const matched = await runGlob(pattern, {
                cwd: fullPath,
                ignore: TRAVERSAL_PRUNE,
                nodir: true,
            });
            // Secret-path denylist: never enumerate .env-style files — listing
            // names leaks that secrets exist and invites a follow-up read.
            let files = matched.filter(
                (f) => !isBlockedSecretBasename(path.basename(f)),
            );
            // Honor the workspace .atlarixignore (same source of truth as the
            // Blueprint index), so OS/editor cruft like .DS_Store / .vscode /
            // .idea — and any user-defined excludes — never reach the model.
            if (workspace) {
                const ig = await loadIgnorerForProject(workspace);
                files = files.filter((f) => {
                    const relToWs = path
                        .relative(workspace, path.join(fullPath, f))
                        .replace(/\\/g, "/");
                    return !relToWs || !isRelPathIgnored(ig, relToWs);
                });
            }

            if (files.length === 0) {
                return `No files found matching pattern: ${pattern}. Often an extension or casing issue — try a broader glob (e.g. "**/${pattern}"), or use grep to find the file by its content.`;
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
