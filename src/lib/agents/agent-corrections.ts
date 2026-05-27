/** No-op: agent bus removed; corrections from main are not routed on a bus. */
export function drainAgentCorrections(
  _turnId: string,
  _agentId: string,
): string[] {
  return [];
}
