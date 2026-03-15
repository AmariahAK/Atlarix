/**
 * Stream tools — v3.9
 * stream_terminal_output: collect terminal output matching a pattern (from run_command in this chat).
 * stream_pipeline_logs: collect pipeline/job logs (e.g. GitHub Actions); pipeline stub until section 5.
 */

import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
} from "./registry";
import {
  openStream,
  closeStream,
  getCollectedLines,
  setStreamInactive,
} from "../streams/StreamManager";

const DEFAULT_MAX_LINES = 50;
const MAX_MAX_LINES = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

ToolRegistry.register({
  name: "stream_terminal_output",
  description:
    "Collect live terminal output from commands run in this chat. Opens a stream that collects lines matching an optional pattern (regex), with a line limit and timeout. Use when you need to see the output of a command the user or you are about to run (e.g. run_command). Returns collected lines as text. Only captures output from this conversation's run_command executions.",
  category: ToolCategory.EXECUTION,
  cost: 2,
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      pattern: stringParam(
        "Optional regex pattern to filter lines (e.g. 'error|Error|ERROR'). If omitted, all lines are collected."
      ),
      maxLines: {
        type: "number",
        description: `Max lines to collect (default ${DEFAULT_MAX_LINES}, max ${MAX_MAX_LINES})`,
      },
      timeoutMs: {
        type: "number",
        description: `How long to wait for output in ms (default ${DEFAULT_TIMEOUT_MS})`,
      },
    },
    []
  ),
  handler: async (args: any) => {
    const pattern = args.pattern ?? "";
    const maxLines = Math.min(
      MAX_MAX_LINES,
      Math.max(1, Number(args.maxLines) || DEFAULT_MAX_LINES)
    );
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const chatId = args.chatId ?? null;
    const sendToolActivity = args._sendToolActivity as
      | ((label: string) => () => void)
      | undefined;

    let endActivity: (() => void) | undefined;
    if (sendToolActivity) {
      endActivity = sendToolActivity("AI is watching terminal...");
    }

    try {
      const streamId = openStream("terminal", {
        chatId,
        filter: pattern || null,
        maxLines,
        timeoutMs,
      });

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { lines, active } = getCollectedLines(streamId);
        if (!active || lines.length >= maxLines) {
          break;
        }
        await sleep(500);
      }

      const { lines } = getCollectedLines(streamId);
      closeStream(streamId);
      if (endActivity) endActivity();

      if (lines.length === 0) {
        return "No terminal output collected within the timeout. Run a command (e.g. run_command) in this chat to produce output.";
      }
      return lines.join("\n");
    } catch (err) {
      if (endActivity) endActivity();
      throw err;
    }
  },
});

ToolRegistry.register({
  name: "stream_pipeline_logs",
  description:
    "Collect logs from a CI/CD pipeline job (e.g. GitHub Actions). Provide the job ID; logs are polled until the job completes or max lines reached. Use when the user wants to inspect workflow or job logs. Pipeline support depends on connected providers (e.g. GitHub Actions in v3.9).",
  category: ToolCategory.EXECUTION,
  cost: 2,
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      jobId: {
        type: "number",
        description: "Pipeline job ID (e.g. GitHub Actions job id)",
      },
      filter: stringParam("Optional regex to filter log lines"),
      maxLines: {
        type: "number",
        description: `Max lines to collect (default ${DEFAULT_MAX_LINES}, max ${MAX_MAX_LINES})`,
      },
    },
    ["jobId"]
  ),
  handler: async (args: any) => {
    const jobId = Number(args.jobId);
    const filter = args.filter ?? null;
    const maxLines = Math.min(
      MAX_MAX_LINES,
      Math.max(1, Number(args.maxLines) || DEFAULT_MAX_LINES)
    );
    const sendToolActivity = args._sendToolActivity as
      | ((label: string) => () => void)
      | undefined;

    let endActivity: (() => void) | undefined;
    if (sendToolActivity) {
      endActivity = sendToolActivity("AI is monitoring pipeline...");
    }

    try {
      // v3.9: Pipeline stream stub — real implementation in section 5 with GitHub Actions
      const streamId = openStream("pipeline", {
        chatId: args.chatId ?? null,
        filter,
        maxLines,
        timeoutMs: 60_000,
        jobId,
      });

      // Stub: no provider to poll yet; close after a short wait and return message
      await sleep(2000);
      setStreamInactive(streamId);
      const { lines } = getCollectedLines(streamId);
      closeStream(streamId);
      if (endActivity) endActivity();

      return "Pipeline log streaming is available when a CI provider (e.g. GitHub Actions) is connected. Connect GitHub in Settings → Extensions to monitor workflow runs and job logs.";
    } catch (err) {
      if (endActivity) endActivity();
      throw err;
    }
  },
});
