/**
 * Qodo-style semantic AI review: balanced model, structured output (verdict, score, issues).
 * Categories: Security, Logic, Agent Protocol, Architecture, Performance.
 */

export type ReviewVerdict = "approved" | "needs_changes" | "critical_issues";

export type AgentAction = "notify_builder" | "notify_architect" | "escalate_to_main" | null;

export interface SemanticReviewIssue {
  severity: "critical" | "warning" | "info";
  category: "security" | "logic" | "agent_protocol" | "architecture" | "performance";
  file?: string;
  line?: number;
  message: string;
  suggested_fix?: string;
  agent_action: AgentAction;
}

export interface SemanticReviewResult {
  verdict: ReviewVerdict;
  score: number;
  issues: SemanticReviewIssue[];
  summary: string;
  lightning_signal?: { pattern: string; resolution_hint: string };
}

export const QODO_REVIEW_SYSTEM = `You are a code reviewer. Output JSON only.
Categories: security, logic, agent_protocol, architecture, performance.
Verdict: approved | needs_changes | critical_issues.
Score: 0-100.
For each issue: severity (critical|warning|info), category, file, line, message, suggested_fix, agent_action (notify_builder | notify_architect | escalate_to_main | null).
summary: one sentence for Activity Stream.
lightning_signal: optional { pattern, resolution_hint } for learning.`;

export const QODO_REVIEW_USER_PREFIX = `Review this change. Return JSON with keys: verdict, score, issues, summary, lightning_signal (optional).

`;
