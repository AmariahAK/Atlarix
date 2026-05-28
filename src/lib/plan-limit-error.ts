/** Expected gating when free tier workspace/MCP limits are hit — not a product defect. */
export class PlanLimitError extends Error {
  readonly code = "ATLARIX_PLAN_LIMIT" as const;

  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

export function isPlanLimitError(error: unknown): boolean {
  if (error instanceof PlanLimitError) return true;
  if (error instanceof Error) {
    if (error.name === "PlanLimitError") return true;
    const msg = error.message;
    return (
      msg.includes("Free plan allows") ||
      msg.includes("Workspace limit reached") ||
      msg.includes("Upgrade to Pro for unlimited workspaces") ||
      msg.includes("Free tier is limited to 1 MCP")
    );
  }
  if (typeof error === "string") {
    return (
      error.includes("Free plan allows") ||
      error.includes("Workspace limit reached")
    );
  }
  return false;
}
