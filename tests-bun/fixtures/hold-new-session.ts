/**
 * An editor that has just opened a session in this folder and not yet said so
 * in the live registry (its inbox is still starting): what a CLI starting at the
 * same moment meets (A7). Prints `SESSION <id>`, then waits for stdin to close.
 *
 *   bun run --preload ./tests-bun/preload.ts tests-bun/fixtures/hold-new-session.ts <userData> <workspace>
 */
const [userData, workspace] = process.argv.slice(2) as [string, string];
process.env.ATLARIX_USER_DATA_DIR = userData;
process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
process.env.ATLARIX_SURFACE = "cli";
process.on("unhandledRejection", () => {});

const { listFolderSessions } = await import("../../src/cli/agent/session");
await listFolderSessions(workspace); // the database and handlers, as `atlarix acp` has them
const { workspaceAppIdForPath } = await import("../../src/lib/workspace-app-by-path");
const { invoke } = await import("../../src/cli/agent/ipc");
const started = await invoke<{ sessionId: string }>("sessions:start", await workspaceAppIdForPath(workspace), { claim: true });
console.log(`SESSION ${started.sessionId}`);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
