export function parseRemoteUri(
  uri: string,
): { hostAlias: string; remotePath: string } | null {
  const m = uri.match(/^atlarix-remote:\/\/ssh\+([^/]+)(\/.*)?$/);
  if (!m) return null;
  return {
    hostAlias: decodeURIComponent(m[1]),
    remotePath: m[2] || "/",
  };
}
