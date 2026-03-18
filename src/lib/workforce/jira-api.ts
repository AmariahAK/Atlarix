/**
 * Jira REST API helpers — used by workforce tools and Workspace Context.
 * Uses Atlassian OAuth: first get accessible resources, then query Jira.
 */

async function getJiraBaseUrl(accessToken: string): Promise<string | null> {
  const res = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ url?: string }>;
  const first = data?.[0]?.url;
  return first ?? null;
}

export async function fetchAssignedTickets(accessToken: string): Promise<string[]> {
  const base = await getJiraBaseUrl(accessToken);
  if (!base) return [];
  const res = await fetch(
    `${base}/rest/api/3/search?jql=${encodeURIComponent("assignee = currentUser() ORDER BY updated DESC")}&maxResults=10&fields=summary,key,status`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { issues?: Array<{ key?: string; fields?: { summary?: string; status?: { name?: string } } }> };
  const issues = data.issues ?? [];
  return issues.map((i) => `${i.key ?? "?"}: ${i.fields?.summary ?? ""} (${i.fields?.status?.name ?? ""})`);
}
