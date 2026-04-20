export type CounselTrigger =
  | "user_command"
  | "auto_complex"
  | "agent_blocker"
  | "low_confidence"
  /** One-shot deep think when the model has no native reasoning API — counsel runs as substitute. */
  | "deep_think_fallback";

export type CounselMode = "general" | "workspace";

export type CounselParticipantRole = "fast" | "balanced" | "thinking";

export interface CounselParticipant {
  role: CounselParticipantRole;
  modelId: string;
  response?: string;
  signaled: boolean;
  startedAt: number;
  completedAt?: number;
  timedOut?: boolean;
}

export interface CounselSession {
  sessionId: string;
  turnId: string;
  chatId: number;
  trigger: CounselTrigger;
  mode: CounselMode;
  question: string;
  participants: CounselParticipant[];
  synthesis?: string;
  status: "running" | "synthesising" | "complete" | "timeout";
  createdAt: number;
  completedAt?: number;
}
