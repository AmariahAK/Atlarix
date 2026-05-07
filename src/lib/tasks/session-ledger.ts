/**
 * Session Ledger — model-maintained task tracker that persists for a session.
 * Model calls update_ledger to track plan, completed steps, files read/written, pending work.
 * Auto-injected into context before user message. Cleared on new chat.
 */

export interface SessionLedgerEntry {
  plan?: string;
  completed?: string[];
  pending?: string[];
  filesRead?: string[];
  filesModified?: string[];
  notes?: string[];
  startedAt: Date;
  lastUpdated: Date;
}

const sessionLedgers = new Map<number, SessionLedgerEntry>();

export function getSessionLedger(chatId: number): SessionLedgerEntry | undefined {
  return sessionLedgers.get(chatId);
}

export function createSessionLedger(chatId: number, plan?: string): SessionLedgerEntry {
  const ledger: SessionLedgerEntry = {
    plan,
    completed: [],
    pending: [],
    filesRead: [],
    filesModified: [],
    notes: [],
    startedAt: new Date(),
    lastUpdated: new Date(),
  };
  sessionLedgers.set(chatId, ledger);
  return ledger;
}

export function updateSessionLedger(
  chatId: number,
  update: {
    plan?: string;
    completed?: string[];
    pending?: string[];
    filesRead?: string[];
    filesModified?: string[];
    notes?: string;
  },
): SessionLedgerEntry {
  let ledger = sessionLedgers.get(chatId);
  if (!ledger) {
    ledger = createSessionLedger(chatId, update.plan);
  }

  if (update.plan !== undefined) {
    ledger.plan = update.plan;
  }
  if (update.completed?.length) {
    ledger.completed = [...(ledger.completed ?? []), ...update.completed];
  }
  if (update.pending?.length) {
    ledger.pending = [...(ledger.pending ?? []), ...update.pending];
  }
  if (update.filesRead?.length) {
    ledger.filesRead = [...new Set([...(ledger.filesRead ?? []), ...update.filesRead])];
  }
  if (update.filesModified?.length) {
    ledger.filesModified = [...new Set([...(ledger.filesModified ?? []), ...update.filesModified])];
  }
  if (update.notes) {
    ledger.notes = [...(ledger.notes ?? []), update.notes];
  }
  ledger.lastUpdated = new Date();

  sessionLedgers.set(chatId, ledger);
  return ledger;
}

export function clearSessionLedger(chatId: number): void {
  sessionLedgers.delete(chatId);
}

export function formatSessionLedger(ledger: SessionLedgerEntry): string {
  const lines: string[] = ["## Session Ledger"];

  if (ledger.plan) {
    lines.push(`Plan: ${ledger.plan}`);
  }

  const done = ledger.completed ?? [];
  if (done.length > 0) {
    lines.push(`Done: ${done.join("; ")}`);
  }

  const pending = ledger.pending ?? [];
  if (pending.length > 0) {
    lines.push(`Pending: ${pending.join("; ")}`);
  }

  const read = ledger.filesRead ?? [];
  if (read.length > 0) {
    lines.push(`Files read: ${read.join(", ")}`);
  }

  const modified = ledger.filesModified ?? [];
  if (modified.length > 0) {
    lines.push(`Files modified: ${modified.join(", ")}`);
  }

  const notes = ledger.notes ?? [];
  if (notes.length > 0) {
    lines.push(`Notes: ${notes.join(" | ")}`);
  }

  return lines.join("\n");
}
