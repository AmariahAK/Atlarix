import { expect } from "vitest";
import type { RecordedSend } from "./ipc";
import type { TempWorkspace } from "./workspace";
import type { TestDb } from "./db";

/**
 * Assert the ordered tool-call sequence of a turn. Reads `chat:tool:start`
 * sends (payload.toolId is the registry tool name).
 */
export function expectToolSequence(
  sends: RecordedSend[],
  expected: string[],
): void {
  const actual = sends
    .filter((s) => s.channel === "chat:tool:start")
    .map((s) => s.payload?.toolId);
  expect(actual).toEqual(expected);
}

/** Subsequence variant: every expected tool appears, in order, extras allowed. */
export function expectToolSubsequence(
  sends: RecordedSend[],
  expected: string[],
): void {
  const actual = sends
    .filter((s) => s.channel === "chat:tool:start")
    .map((s) => s.payload?.toolId as string);
  let cursor = 0;
  for (const name of expected) {
    const found = actual.indexOf(name, cursor);
    expect(
      found,
      `expected tool "${name}" (in order) — actual sequence: ${actual.join(" → ") || "(none)"}`,
    ).toBeGreaterThanOrEqual(0);
    cursor = found + 1;
  }
}

export function expectFile(
  ws: TempWorkspace,
  rel: string,
  matcher: string | RegExp,
): void {
  expect(ws.exists(rel), `expected ${rel} to exist in workspace`).toBe(true);
  const content = ws.read(rel);
  if (typeof matcher === "string") {
    expect(content).toContain(matcher);
  } else {
    expect(content).toMatch(matcher);
  }
}

/** Assert a persisted session message exists (content substring match). */
export async function expectDbSessionMessage(
  testDb: TestDb,
  opts: { role: "user" | "assistant"; contentContains: string },
): Promise<void> {
  const rows = await testDb.db.query.sessionMessages.findMany();
  const hit = rows.some(
    (m: any) =>
      m.role === opts.role &&
      String(m.content ?? "").includes(opts.contentContains),
  );
  expect(
    hit,
    `expected a persisted ${opts.role} session message containing ${JSON.stringify(opts.contentContains)} — got ${rows.length} rows`,
  ).toBe(true);
}

/** The terminal `chat:response:end` for a chat (every turn must send one). */
export function expectStreamEnded(sends: RecordedSend[], chatId: number): void {
  const ends = sends.filter(
    (s) => s.channel === "chat:response:end" && s.payload?.chatId === chatId,
  );
  expect(ends.length, "expected chat:response:end").toBeGreaterThanOrEqual(1);
}

/** No `chat:response:error` was sent for the chat. */
export function expectNoStreamError(
  sends: RecordedSend[],
  chatId: number,
): void {
  const errors = sends.filter(
    (s) => s.channel === "chat:response:error" && s.payload?.chatId === chatId,
  );
  expect(
    errors.map((e) => e.payload?.error),
    "expected no chat:response:error",
  ).toEqual([]);
}
