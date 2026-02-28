/**
 * SonarQube integration for PIVOT analysis layer.
 * Optional: requires user to configure URL + token in settings.
 */

export interface SonarConfig {
  baseUrl: string;
  token: string;
  projectKey?: string;
}

export interface SonarIssue {
  key: string;
  file: string;
  line?: number;
  message: string;
  severity: string;
  type: string;
  rule: string;
}

export interface SonarResult {
  success: boolean;
  issues?: SonarIssue[];
  error?: string;
}

/**
 * Fetch issues from SonarQube API for a project.
 * No-op if config is missing or invalid.
 */
export async function fetchSonarIssues(
  config: SonarConfig | null,
  projectKey?: string,
): Promise<SonarResult> {
  if (!config?.baseUrl?.trim() || !config?.token?.trim()) {
    return { success: false, error: "SonarQube not configured (baseUrl + token required)" };
  }
  const key = projectKey ?? config.projectKey;
  if (!key) {
    return { success: false, error: "Project key required" };
  }
  const url = `${config.baseUrl.replace(/\/$/, "")}/api/issues/search?projectKeys=${encodeURIComponent(key)}&ps=100`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      return { success: false, error: `SonarQube API ${res.status}: ${res.statusText}` };
    }
    const data = (await res.json()) as { issues?: Array<{ key?: string; component?: string; line?: number; message?: string; severity?: string; type?: string; rule?: string }> };
    const issues: SonarIssue[] = (data.issues ?? []).map((i) => ({
      key: i.key ?? "",
      file: (i.component ?? "").split(":").pop() ?? "",
      line: i.line,
      message: i.message ?? "",
      severity: i.severity ?? "INFO",
      type: i.type ?? "CODE_SMELL",
      rule: i.rule ?? "",
    }));
    return { success: true, issues };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "SonarQube request failed",
    };
  }
}
