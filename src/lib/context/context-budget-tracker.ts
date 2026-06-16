/**
 * Pure ratio math against a model's effective context budget.
 * No provider or tier policy — only `tierLimit` and `estimatedTokens`.
 */

export type ContextBudgetHealth = "healthy" | "warning" | "critical" | "over";

export class ContextBudgetTracker {
  constructor(
    private readonly tierLimit: number,
    private readonly estimatedTokens: number,
  ) {}

  getUsageRatio(): number {
    if (this.tierLimit <= 0) return 1;
    return this.estimatedTokens / this.tierLimit;
  }

  getBudgetTier(): ContextBudgetHealth {
    const r = this.getUsageRatio();
    if (r < 0.5) return "healthy";
    if (r < 0.7) return "warning";
    if (r < 0.85) return "critical";
    return "over";
  }

  isHealthy(): boolean {
    return this.getBudgetTier() === "healthy";
  }

  isWarning(): boolean {
    return this.getBudgetTier() === "warning";
  }

  isCritical(): boolean {
    return this.getBudgetTier() === "critical";
  }

  isOverLimit(): boolean {
    return this.getBudgetTier() === "over";
  }

  getTierLimit(): number {
    return this.tierLimit;
  }

  getEstimatedTokens(): number {
    return this.estimatedTokens;
  }
}
