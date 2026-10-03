/**
 * This process, as written on the automation leases and runs it takes
 * (runner.ts). The desktop app and the CLI share one database; this is how
 * each tells its own running runs from the other's.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";

export const PROCESS_OWNER = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
