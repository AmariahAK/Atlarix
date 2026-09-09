/** Logged operation from an autonomous session (Build stream + delegated agents). */
export interface AutonomousOp {
  operationId: string;
  type: string;
  path?: string;
  summary?: string;
  timestamp: number;
  result: "success" | "failed";
  reverted: boolean;
}

function sessionKey(chatId: number, turnId: string): string {
  return `${chatId}:${turnId}`;
}

const sessionLogs = new Map<string, AutonomousOp[]>();
/** Serialized bus traffic for a turn (filled when AgentMessage carries turnId). */
const agentActivityByTurn = new Map<string, Record<string, unknown>[]>();

export function appendAutonomousOp(
  chatId: number,
  turnId: string,
  op: AutonomousOp,
): void {
  const k = sessionKey(chatId, turnId);
  const list = sessionLogs.get(k) ?? [];
  list.push(op);
  sessionLogs.set(k, list);
}

export function getAutonomousSessionLog(
  chatId: number,
  turnId: string,
): AutonomousOp[] {
  return [...(sessionLogs.get(sessionKey(chatId, turnId)) ?? [])];
}

export function getAgentActivityForTurn(
  chatId: number,
  turnId: string,
): Record<string, unknown>[] {
  return [...(agentActivityByTurn.get(sessionKey(chatId, turnId)) ?? [])];
}

export function clearAutonomousSession(chatId: number, turnId: string): void {
  const k = sessionKey(chatId, turnId);
  sessionLogs.delete(k);
  agentActivityByTurn.delete(k);
}

export function markAutonomousOpReverted(
  chatId: number,
  turnId: string,
  operationId: string,
): boolean {
  const list = sessionLogs.get(sessionKey(chatId, turnId));
  if (!list) return false;
  const op = list.find((o) => o.operationId === operationId);
  if (!op) return false;
  op.reverted = true;
  return true;
}

export function findAutonomousOp(
  chatId: number,
  turnId: string,
  operationId: string,
): AutonomousOp | undefined {
  return sessionLogs
    .get(sessionKey(chatId, turnId))
    ?.find((o) => o.operationId === operationId);
}

export function autonomousOpFromPermissionExec(
  operationId: string,
  operationType: string,
  preview: unknown,
  execApproved: boolean,
): AutonomousOp {
  let path: string | undefined;
  let summary: string | undefined;
  const p = preview;
  if (Array.isArray(p)) {
    const first = p[0] as { path?: string; description?: string } | undefined;
    path = first?.path;
    summary = first?.description;
  } else if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    if (typeof o.path === "string") path = o.path;
    if (typeof o.command === "string") path = o.command;
    if (typeof o.description === "string") summary = o.description;
  }
  return {
    operationId,
    type: operationType,
    path,
    summary: summary ?? operationType,
    timestamp: Date.now(),
    result: execApproved ? "success" : "failed",
    reverted: false,
  };
}
