/**
 * Model capability registry: contextWindow, supportsToolCalling, supportsVision, tier.
 * Persisted to user data path (Electron main process); infer tier from model name when API unavailable.
 */

export type ModelTier = "fast" | "balanced" | "thinking";
