/**
 * Post-turn self-correction: optional follow-up stream when TSC / dev output / tests indicate issues.
 * Shared cap: max 2 auto-correction user messages per root assistant turn (key: chatId:rootAssistantId).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WebContents } from "electron";
import log from "electron-log";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { readSettings } from "@/main/settings";
import { generateProblemReport } from "../processors/tsc";
import { createProblemFixPrompt } from "@/shared/problem_prompt";
import { safeSend } from "../utils/safe_sender";
import { DevServerManager } from "@/lib/dev_server_manager";

const logger = log.scope("self_correction_followup");
const execFileAsync = promisify(execFile);

const MAX_CORRECTIONS_PER_ROOT = 2;
const correctionAttempts = new Map<string, number>();
/** Assistant message id from the pre-correction turn; reused for cap while the chain continues. */
const pendingSelfCorrectionRootByChatId = new Map<number, number>();

function capKey(chatId: number, rootAssistantMessageId: number): string {
  return `${chatId}:${rootAssistantMessageId}`;
}

export function clearSelfCorrectionAttemptsForChat(chatId: number): void {
  pendingSelfCorrectionRootByChatId.delete(chatId);
  for (const k of [...correctionAttempts.keys()]) {
    if (k.startsWith(`${chatId}:`)) correctionAttempts.delete(k);
  }
}

function looksLikeRuntimeError(text: string): boolean {
  const t = text.toUpperCase();
  return (
    /\b(ERROR|TypeError|ReferenceError|SyntaxError|FAILED|FAILURE)\b/.test(t) ||
    /Cannot find module/i.test(text) ||
    /Unhandled/i.test(text)
  );
}

async function resolveTestFileForSource(
  workspacePath: string,
  relPosix: string,
): Promise<string | null> {
  const normalized = relPosix.split(path.sep).join("/");
  const ext = path.extname(normalized);
  const base = normalized.slice(0, -ext.length) || normalized;
  const candidates = [
    `${base}.test${ext}`,
    `${base}.spec${ext}`,
    normalized.replace(/(\.[^./]+)$/, ".test$1"),
    normalized.replace(/(\.[^./]+)$/, ".spec$1"),
  ];
  for (const c of candidates) {
    const abs = path.join(workspacePath, ...c.split("/"));
    try {
      await fs.access(abs);
      return c.split("/").join(path.sep);
    } catch {
      // try next
    }
  }
  return null;
}

async function runTargetedTestOnce(
  workspacePath: string,
  testRelPath: string,
): Promise<{ ok: boolean; output: string }> {
  const pkgRaw = await fs.readFile(path.join(workspacePath, "package.json"), "utf-8");
  const pkg = JSON.parse(pkgRaw) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const testScript = pkg.scripts?.test;
  if (!testScript || typeof testScript !== "string") {
    return { ok: true, output: "" };
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const usesVitest =
    /vitest/.test(testScript) || Boolean(deps?.vitest) || Boolean(deps?.["@vitest/coverage-v8"]);
  const testAbs = path.join(workspacePath, ...testRelPath.split(/[/\\]/));

  try {
    if (usesVitest) {
      const { stdout, stderr } = await execFileAsync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["vitest", "run", testAbs],
        {
          cwd: workspacePath,
          timeout: 90_000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, CI: "1" },
        },
      );
      const output = `${stdout}\n${stderr}`;
      const failed = /FAIL|failed|\d failed|AssertionError/i.test(output);
      return { ok: !failed, output };
    }
    if (/jest/.test(testScript) || deps?.jest) {
      const { stdout, stderr } = await execFileAsync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["jest", "--runTestsByPath", testAbs],
        {
          cwd: workspacePath,
          timeout: 90_000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, CI: "1" },
        },
      );
      const output = `${stdout}\n${stderr}`;
      const failed = /FAIL|Test Suites:.*failed|AssertionError/i.test(output);
      return { ok: !failed, output };
    }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? String(e)}`;
    return { ok: false, output };
  }
  return { ok: true, output: "" };
}

/**
 * Queue a synthetic user message under the same cap as TSC/dev/test self-correction (max 2 per root turn).
 * Used for build verification follow-ups; does not run problem report / dev server / tests.
 */
export async function enqueueSyntheticFollowUpIfUnderCap(opts: {
  webContents: WebContents;
  chatId: number;
  rootAssistantMessageId: number;
  content: string;
  label: string;
}): Promise<boolean> {
  if (opts.chatId < 0) return false;
  const rootForCap =
    pendingSelfCorrectionRootByChatId.get(opts.chatId) ?? opts.rootAssistantMessageId;
  const k = capKey(opts.chatId, rootForCap);
  const used = correctionAttempts.get(k) ?? 0;
  if (used >= MAX_CORRECTIONS_PER_ROOT) return false;
  correctionAttempts.set(k, used + 1);
  pendingSelfCorrectionRootByChatId.set(opts.chatId, rootForCap);
  await db.insert(messages).values({
    chatId: opts.chatId,
    role: "user",
    content: opts.content,
    isSynthetic: true,
  });
  safeSend(opts.webContents, "chat:auto-self-correct", {
    chatId: opts.chatId,
  });
  logger.info(
    `Scheduled synthetic follow-up (${opts.label}) for chat ${opts.chatId}, attempt ${used + 1}`,
  );
  return true;
}

export async function schedulePostTurnSelfCorrection(opts: {
  webContents: WebContents;
  chatId: number;
  rootAssistantMessageId: number;
  appId: number | undefined;
  appPathResolved: string;
  filesWrittenInThisExchange: string[];
  isBuildModeTurn: boolean;
  isEphemeralWorkspace: boolean;
  aborted: boolean;
  /** True while this chat still has an active chat:stream (re-entrancy guard). */
  isStreamActive?: () => boolean;
}): Promise<void> {
  if (opts.aborted) return;
  if (opts.isEphemeralWorkspace) return;
  if (!opts.isBuildModeTurn) return;

  if (opts.isStreamActive?.()) {
    logger.info(
      `Self-correction skipped: chat ${opts.chatId} still has an active stream`,
    );
    return;
  }

  const [tail] = await db
    .select({
      id: messages.id,
      role: messages.role,
    })
    .from(messages)
    .where(eq(messages.chatId, opts.chatId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (
    !tail ||
    tail.role !== "assistant" ||
    tail.id !== opts.rootAssistantMessageId
  ) {
    logger.info(
      `Self-correction skipped: chat ${opts.chatId} tail is not completing assistant (user may have continued)`,
    );
    return;
  }

  const settings = readSettings();
  if (!settings.enableAutoFixProblems) return;
  if (!opts.appId || !opts.appPathResolved) return;

  const rootForCap =
    pendingSelfCorrectionRootByChatId.get(opts.chatId) ?? opts.rootAssistantMessageId;
  const k = capKey(opts.chatId, rootForCap);
  const used = correctionAttempts.get(k) ?? 0;
  if (used >= MAX_CORRECTIONS_PER_ROOT) return;

  const trySchedule = async (body: string, label: string): Promise<boolean> => {
    const n = correctionAttempts.get(k) ?? 0;
    if (n >= MAX_CORRECTIONS_PER_ROOT) return false;
    correctionAttempts.set(k, n + 1);
    pendingSelfCorrectionRootByChatId.set(opts.chatId, rootForCap);
    const header = `Auto-correction (${label})\n\n`;
    const content = header + body;
    await db.insert(messages).values({
      chatId: opts.chatId,
      role: "user",
      content,
      isSynthetic: true,
    });
    safeSend(opts.webContents, "chat:auto-self-correct", {
      chatId: opts.chatId,
    });
    logger.info(`Scheduled self-correction for chat ${opts.chatId} (${label}), attempt ${n + 1}`);
    return true;
  };

  try {
    const report = await generateProblemReport({
      fullResponse: "",
      appPath: opts.appPathResolved,
    });
    if (report.problems.length > 0) {
      const prompt = createProblemFixPrompt(report);
      await trySchedule(prompt, `${report.problems.length} TypeScript issue(s)`);
      return;
    }
  } catch (e) {
    logger.warn("Self-correction: generateProblemReport failed", e);
  }

  const lines = DevServerManager.getInstance().getRecentOutputLines(opts.appId, 200);
  if (lines.length > 0) {
    const text = lines.join("\n").slice(-12_000);
    if (looksLikeRuntimeError(text)) {
      const scheduled = await trySchedule(
        `Dev server / watcher output:\n\`\`\`\n${text}\n\`\`\`\n\nFix the underlying issue.`,
        "runtime output",
      );
      if (scheduled) {
        DevServerManager.getInstance().clearOutputBuffer(opts.appId);
      }
      return;
    }
  }

  const written = opts.filesWrittenInThisExchange ?? [];
  if (written.length === 0) return;

  for (const rel of written) {
    const posix = rel.split(path.sep).join("/");
    const testRel = await resolveTestFileForSource(opts.appPathResolved, posix);
    if (!testRel) continue;
    const { ok, output } = await runTargetedTestOnce(opts.appPathResolved, testRel);
    if (!ok && output.trim()) {
      await trySchedule(
        `Tests failed for \`${testRel}\`:\n\`\`\`\n${output.slice(0, 24_000)}\n\`\`\`\n\nFix the failures.`,
        "tests failed",
      );
      return;
    }
  }
}
