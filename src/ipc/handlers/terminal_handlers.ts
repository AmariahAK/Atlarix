/**
 * Terminal IPC — interactive user commands + shared streaming output channel.
 */

import { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { randomUUID } from "crypto";
import { z } from "zod";
import log from "electron-log";
import {
  runShellCommandStreaming,
  killShellProcess,
  type CommandResult,
} from "../utils/runShellCommand";
import { createLoggedHandler } from "./safe_handle";
import type { ChildProcess } from "child_process";

const logger = log.scope("terminal-handlers");

export interface TerminalRunParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  chatId?: number;
  source?: "user" | "agent";
}

/** Runtime shape gate for the privileged `terminal:run` channel (defense in depth
 * behind the CSP): a hijacked frame can't smuggle a non-string command or extras. */
const TerminalRunParamsSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  chatId: z.number().optional(),
  source: z.enum(["user", "agent"]).optional(),
});

export interface TerminalRunResult {
  exitCode: number;
  output: string;
  success: boolean;
  timedOut: boolean;
  command: string;
  operationId: string;
}

function broadcastTerminalOutput(payload: {
  chatId: number;
  commandId: string;
  command: string;
  output: string;
  status: "running" | "completed" | "error";
  exitCode?: number;
  source?: "user" | "agent";
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("terminal-output", payload);
  }
}

function trimOutputForResult(
  stdout: string,
  stderr: string,
  maxBytes = 8000,
): string {
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(-maxBytes);
}

export function registerTerminalHandlers(): void {
  const handle = createLoggedHandler(logger);
  handle(
    "terminal:run",
    async (
      _event: IpcMainInvokeEvent,
      rawParams: unknown,
    ): Promise<TerminalRunResult> => {
      const params = TerminalRunParamsSchema.parse(rawParams);
      const command = String(params.command ?? "").trim();
      if (!command) {
        return {
          exitCode: 1,
          output: "No command provided",
          success: false,
          timedOut: false,
          command: "",
          operationId: randomUUID(),
        };
      }

      const cwd = params.cwd;
      const timeoutMs = Math.min(
        1_800_000,
        Math.max(1000, Number(params.timeoutMs) || 120_000),
      );
      const chatId = params.chatId ?? 0;
      const source = params.source ?? "user";
      const operationId = `${source}-${randomUUID()}`;

      logger.log(
        `[terminal:run] ${source}: ${command}${cwd ? ` in ${cwd}` : ""}`,
      );

      broadcastTerminalOutput({
        chatId,
        commandId: operationId,
        command,
        output: "",
        status: "running",
        source,
      });

      let proc: ChildProcess | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      try {
        const result = await new Promise<CommandResult>((resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            killShellProcess(proc);
            reject(
              new Error(
                `Command timed out after ${Math.round(timeoutMs / 1000)}s`,
              ),
            );
          }, timeoutMs);

          runShellCommandStreaming(command, cwd, {
            onSpawn: (p) => {
              proc = p;
            },
            onOutput: ({ stdout, stderr }) => {
              const output = stdout + (stderr ? `\n${stderr}` : "");
              broadcastTerminalOutput({
                chatId,
                commandId: operationId,
                command,
                output,
                status: "running",
                source,
              });
            },
          })
            .then((r) => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              resolve(r);
            })
            .catch((err) => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              reject(err);
            });
        });

        const output = trimOutputForResult(result.stdout, result.stderr);
        broadcastTerminalOutput({
          chatId,
          commandId: operationId,
          command,
          output: result.stdout + (result.stderr ? `\n${result.stderr}` : ""),
          status: result.success ? "completed" : "error",
          exitCode: result.exitCode,
          source,
        });

        return {
          exitCode: result.exitCode,
          output,
          success: result.success,
          timedOut: false,
          command,
          operationId,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = message.includes("timed out");
        broadcastTerminalOutput({
          chatId,
          commandId: operationId,
          command,
          output: message,
          status: "error",
          exitCode: timedOut ? 124 : 1,
          source,
        });
        return {
          exitCode: timedOut ? 124 : 1,
          output: message,
          success: false,
          timedOut,
          command,
          operationId,
        };
      }
    },
  );
}
