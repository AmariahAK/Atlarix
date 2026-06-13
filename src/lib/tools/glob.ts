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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

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
        try {
            const fullPath = workspace
                ? resolvePathUnderWorkspace(workspace, searchPath || ".")
                : path.resolve(stripToolPathPrefixes(searchPath || ".") || ".");
            const matched = await runGlob(pattern, {
                cwd: fullPath,
                ignore: ["node_modules/**", ".git/**", "dist/**", "out/**"],
                nodir: true,
            });
            // Secret-path denylist: never enumerate .env-style files — listing
            // names leaks that secrets exist and invites a follow-up read.
            const files = matched.filter(
                (f) => !isBlockedSecretBasename(path.basename(f)),
            );

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
