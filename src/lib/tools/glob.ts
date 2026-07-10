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
    stripToolPathPrefixes,
} from "../../ipc/utils/safeWorkspaceRelativePath";
import { isBlockedSecretBasename } from "@/lib/security/env-secret-paths";
import { ripgrepIgnoreArgs } from "./ripgrep-ignore";

const execFileAsync = promisify(execFile);

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
        // A18/L-3: a `../` segment in the PATTERN would enumerate outside the
        // workspace even though `searchPath` is confined. Reject it.
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

            // ripgrep lists files under cwd (paths relative to it), filtered by
            // .gitignore/.ignore/.atlarixignore. A CATCH-ALL `-g` glob (`*`, `**`,
            // `**/*`) makes ripgrep override those ignores and re-include
            // node_modules/dist — so for the universal patterns we pass NO `-g`
            // (plain `rg --files` is already correctly ignore-filtered) and, for a
            // bare `*`, keep only top-level entries (matching the old glob's
            // non-recursive `*` semantics). Constrained patterns respect ignores.
            const trimmed = pattern.trim();
            const isUniversal =
                trimmed === "" ||
                trimmed === "*" ||
                trimmed === "**" ||
                trimmed === "**/*";
            const ignoreArgs = await ripgrepIgnoreArgs(workspace);
            const rgArgs = ["--files", ...ignoreArgs];
            if (!isUniversal) rgArgs.push("-g", pattern);
            let matched: string[] = [];
            try {
                const { stdout } = await execFileAsync("rg", rgArgs, {
                    cwd: fullPath,
                    maxBuffer: 20 * 1024 * 1024,
                });
                matched = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
            } catch {
                // rg exits non-zero when nothing matches — treat as empty, not error.
                matched = [];
            }
            if (trimmed === "*") {
                // Bare `*` = list this directory's own files, not the whole tree.
                matched = matched.filter((f) => !f.includes("/"));
            }

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
