/**
 * Workforce extensions — v4.0
 * Abstraction for services that use Auth0 Token Vault for agent auth.
 */

/** Data contributed to Workspace Context (Workforce-only) */
export interface WorkspaceContextData {
  openPRs?: string[];
  failingPipelines?: string[];
  assignedTickets?: string[];
  unreadMentions?: string[];
  recentSentryErrors?: string[];
  todaysMeetings?: string[];
  lastUpdated?: string;
}

export interface WorkforceExtension {
  /** Display name (e.g. "Slack") */
  name: string;
  /** Token Vault service key (e.g. "slack") */
  service: string;
  /** OAuth scopes required */
  scopes: string[];
  /** Trigger connect/consent; returns true if connected */
  connect(): Promise<boolean>;
  /** Revoke and disconnect */
  disconnect(): Promise<void>;
  /** Whether the service is currently connected */
  isConnected(): Promise<boolean>;
  /** Optional: contribute to Workspace Context when connected */
  getContextData?(): Promise<Partial<WorkspaceContextData>>;
}
