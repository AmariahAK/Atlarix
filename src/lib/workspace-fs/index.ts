
export interface WorkspaceFs {
  readFile(filePath: string, encoding?: BufferEncoding): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  stat(filePath: string): Promise<{ isDirectory: boolean; isFile: boolean }>;
  readdir(dirPath: string): Promise<string[]>;
}

export function parseRemoteUri(uri: string): { hostAlias: string; remotePath: string } | null {
  const m = uri.match(/^atlarix-remote:\/\/ssh\+([^/]+)(\/.*)?$/);
  if (!m) return null;
  return {
    hostAlias: decodeURIComponent(m[1]),
    remotePath: m[2] || "/",
  };
}
