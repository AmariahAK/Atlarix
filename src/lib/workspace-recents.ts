const RECENTS_KEY = "atlarix_recent_workspaces";
const MAX_RECENTS = 5;

export function loadRecentWorkspaces(): string[] {
  try {
    const stored = localStorage.getItem(RECENTS_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

export function pushRecentWorkspace(path: string): string[] {
  const updated = [path, ...loadRecentWorkspaces().filter((p) => p !== path)].slice(
    0,
    MAX_RECENTS,
  );
  localStorage.setItem(RECENTS_KEY, JSON.stringify(updated));
  return updated;
}
