/**
 * Streams a headless run's interaction history to a JSONL file, one event per line.
 *
 * WHY STREAM RATHER THAN BUFFER. A benchmark orchestrator kills the agent at the
 * task timeout, and an agent can also be killed mid-run by its own shell (Harbor
 * issue #2311: the task text lands in the agent's own `/proc/<pid>/cmdline`, so a
 * `pkill -f` naming a process under test matches the agent). SIGKILL cannot be
 * caught in any language — a `finally`, a `process.on("exit")` and a `beforeExit`
 * hook all fail to run. So a trajectory held in memory until a graceful flush
 * produces ZERO bytes in exactly the case that most needs one: a killed trial
 * still scores `reward 0`, and the trajectory is the only thing that makes the
 * failure diagnosable rather than indistinguishable from an infra flake.
 *
 * Streaming synchronously moves the durability boundary from "did the process
 * exit cleanly" to "did this write(2) return", which nothing can take away.
 *
 * THE ONE INVARIANT: exactly one `fs.writeSync` per line, carrying the JSON and
 * its trailing newline together. Splitting a line across two writes (object, then
 * "\n") reintroduces the torn-line risk this design exists to remove. With the
 * invariant held, the worst a killed run can leave is a file that ends after N
 * complete lines — which any `for line in f: json.loads(line)` reader handles.
 *
 * `fs.createWriteStream` is deliberately NOT used: it buffers internally and
 * flushes on a timer/backpressure schedule, which is the very loss window this
 * avoids.
 *
 * Nothing here accumulates. `FakeSender.sends` already retains every event, and a
 * second copy would double that cost on a multi-hour run. The only state kept is
 * the latest assistant content (a single replaced string reference), because the
 * text/reasoning split can only be done once the turn has stopped growing.
 */
import fs from "node:fs";
import { removeThinkingTags } from "@/ipc/utils/thinking_tags";
import { redactSecretsInText } from "@/lib/security/redact-secrets";
import type { RecordedSend } from "./fake-sender";

/** Bump when a field's MEANING changes; additive fields do not need it. */
export const TRAJECTORY_SCHEMA_VERSION = 1;

export interface TrajectoryWriter {
  /** Wire into `makeFakeSender`. Never throws — a broken trajectory must not fail a run. */
  onSend(send: RecordedSend): void;
  recordUserText(text: string): void;
  recordTermination(signal: string): void;
  recordRunEnd(completed: boolean): void;
  close(): void;
}

/** Reasoning emitted inline as tags. See the limitation note on `reasoning` below. */
const THOUGHT_BLOCK_RE =
  /<(think|thinking|reasoning|redacted_thinking)>([\s\S]*?)<\/\1>/gi;

/**
 * Tool activity is emitted as its own `tool_use` events, so leaving the inline
 * pseudo-XML in `assistant_text` would report every call twice — once structured,
 * once as markup a consumer would have to re-parse.
 *
 * The BLOCK goes, not just its tags: the payload between them is the serialized
 * call/result, which is precisely what the `tool_use` events already carry in
 * structured form. Stripping only the delimiters would splice that payload into
 * the prose as though the model had said it.
 */
const TOOL_TAGS =
  "atlarix-tool-call|atlarix-mcp-tool-call|atlarix-tool-result|atlarix-mcp-tool-result";
// `[^>]*` is load-bearing: the live tags carry attributes —
// `<atlarix-tool-call tool="run_command" status="running">` — so a pattern
// anchored on `<tag>` matches nothing a real run produces. Found by a real
// DeepSeek run whose assistant_text still had the whole call block in it, after
// unit tests using bare tags had passed.
const TOOL_BLOCK_RE = new RegExp(
  `<(${TOOL_TAGS})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`,
  "gi",
);
/** Streaming can cut a block in half, leaving an opener or closer behind. */
const TOOL_ORPHAN_TAG_RE = new RegExp(
  `</?(?:${TOOL_TAGS})(?:\\s[^>]*)?>`,
  "gi",
);

function stripToolMarkup(content: string): string {
  return content.replace(TOOL_BLOCK_RE, "").replace(TOOL_ORPHAN_TAG_RE, "");
}

function extractThoughts(content: string): string {
  const out: string[] = [];
  for (const m of content.matchAll(THOUGHT_BLOCK_RE)) {
    const text = m[2]?.trim();
    if (text) out.push(text);
  }
  return out.join("\n\n");
}

export function createTrajectoryWriter(
  filePath: string,
  meta: { workspaceDir: string; model: string; provider: string; mode: string },
): TrajectoryWriter {
  const fd = fs.openSync(filePath, "a");
  let closed = false;
  /** Latest raw assistant content. Replaced, never appended to. */
  let lastAssistantRaw: string | undefined;
  /** Guards against a second `turn_end` if the terminal event is ever re-sent. */
  let turnEnded = false;

  const writeLine = (event: Record<string, unknown>): void => {
    if (closed) return;
    try {
      // Redaction is applied to the SERIALIZED line, not per field, and that is
      // deliberate: a secret can surface in an error message, a tool's stdout, a
      // command's arguments or the model's own prose, and a per-field list would
      // eventually miss one. Redacting once at the boundary cannot.
      //
      // This matters more here than in a log file. A leaderboard submission
      // requires trajectories to be PUBLICLY readable, so this file is destined
      // for publication — and a provider's auth error quotes the key it rejected.
      // The patterns are high-confidence credential shapes only (see
      // redact-secrets.ts), so JSON structure and ordinary text pass through.
      //
      // One syscall, newline included. See THE ONE INVARIANT above.
      const line = redactSecretsInText(JSON.stringify({ ts: Date.now(), ...event }));
      fs.writeSync(fd, `${line}\n`);
    } catch {
      // A full disk or a closed fd must not take the run down with it — the
      // benchmark result is worth more than its trace.
    }
  };

  const flushAssistantText = (): void => {
    const raw = lastAssistantRaw;
    lastAssistantRaw = undefined;
    if (!raw) return;
    const reasoning = extractThoughts(raw);
    if (reasoning) writeLine({ type: "reasoning", text: reasoning });
    const text = stripToolMarkup(removeThinkingTags(raw)).trim();
    if (text) writeLine({ type: "assistant_text", text });
  };

  writeLine({
    type: "run_start",
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    workspaceDir: meta.workspaceDir,
    model: meta.model,
    provider: meta.provider,
    mode: meta.mode,
  });

  return {
    onSend(send) {
      const p = send.payload as Record<string, any> | undefined;
      if (!p) return;

      switch (send.channel) {
        case "chat:activity": {
          if (p.type !== "tool_use") return;
          // A command's completion is announced twice: once as the canonical
          // event carrying toolCallId + args, and once as a bare signal with
          // none of the three. Recording the bare one invents a tool call that
          // never happened — six entries for four calls in a real run — and a
          // trajectory audit reads phantom calls as the agent doing things it
          // did not do. No id, no args and no result is no information.
          if (!p.toolCallId && !p.toolArgs && p.resultText === undefined) return;
          // Emitted twice per call (running, then done/error). BOTH are kept: the
          // running timestamp is the only record of when a tool started, so
          // collapsing them here would discard duration. Pairing by toolCallId is
          // trivial for a consumer that only wants the terminal state.
          writeLine({
            type: "tool_use",
            ts: p.timestamp ?? Date.now(),
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            status: p.status,
            args: p.toolArgs,
            ...(p.resultText === undefined ? {} : { resultText: p.resultText }),
          });
          return;
        }

        case "chat:response:chunk": {
          // Each chunk re-sends the FULL accumulated content, not a delta, so
          // writing per chunk would make the file grow with the square of the
          // reply. Keep only the latest and split it once, at turn end.
          const messages = p.messages as Array<{ role?: string; content?: string }> | undefined;
          const last = messages?.[messages.length - 1];
          if (last?.role === "assistant" && typeof last.content === "string") {
            lastAssistantRaw = last.content;
          }
          return;
        }

        case "chat:token-usage": {
          // This channel carries two different things. The real per-step provider
          // figure has inputTokens/totalTokens; the UI ticker sends
          // `inputTokens: null` with output GUESSED as chars/4 every 400ms.
          // Recording the guess would fill the trajectory with invented telemetry
          // and corrupt any cost derived from it.
          if (p.inputTokens == null || p.totalTokens == null) return;
          writeLine({
            type: "token_usage",
            inputTokens: p.inputTokens,
            outputTokens: p.outputTokens,
            totalTokens: p.totalTokens,
            // Of `inputTokens`, the share served from the provider's prompt
            // cache. Load-bearing for anyone pricing this file: a cached read is
            // a fraction of a fresh one, so gross input alone reads as far more
            // spend than actually occurred — measured at ~75% hit rate on a real
            // agent turn, where ignoring it overstates cost roughly 30x.
            ...(p.cachedInputTokens != null
              ? { cachedInputTokens: p.cachedInputTokens }
              : {}),
            ...(p.cacheCreationInputTokens != null
              ? { cacheCreationInputTokens: p.cacheCreationInputTokens }
              : {}),
          });
          return;
        }

        case "chat:response:end": {
          if (turnEnded) return;
          turnEnded = true;
          flushAssistantText();
          writeLine({
            type: "turn_end",
            turnTokens: p.turnTokens,
            turnCostUsd: p.turnCostUsd,
            turnCachedInputTokens: p.turnCachedInputTokens,
            turnCacheCreationTokens: p.turnCacheCreationTokens,
            totalTokens: p.totalTokens,
            reasoningTokens: p.reasoningTokens,
            auxTokens: p.auxTokens,
            contextWindow: p.contextWindow,
            endedWaitingOnUser: p.endedWaitingOnUser,
          });
          return;
        }

        case "chat:response:error": {
          writeLine({
            type: "error",
            message:
              typeof p.error === "string" ? p.error : (p.message ?? JSON.stringify(p)),
          });
          return;
        }

        default:
          return;
      }
    },

    recordUserText(text) {
      writeLine({ type: "user_text", text });
    },

    recordTermination(signal) {
      // Best-effort marker on the graceful path. It is NOT what makes the file
      // survive — every line before this was already durable. Keep it to one
      // write: the orchestrator follows SIGTERM with SIGKILL after a short grace
      // period, so there is no time for anything slow here.
      flushAssistantText();
      writeLine({ type: "run_terminated", signal });
    },

    recordRunEnd(completed) {
      writeLine({ type: "run_end", completed });
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}
