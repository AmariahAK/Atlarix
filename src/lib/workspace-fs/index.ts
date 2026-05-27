import fs from "node:fs/promises";
import path from "node:path";

export interface WorkspaceFs {
  readFile(filePath: string, encoding?: BufferEncoding): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  stat(filePath: string): Promise<{ isDirectory: boolean; isFile: boolean }>;
  readdir(dirPath: string): Promise<string[]>;
}

export class LocalWorkspaceFs implements WorkspaceFs {
  constructor(private root: string) {}

  resolve(rel: string): string {
    return path.join(this.root, rel);
  }

  async readFile(filePath: string, encoding: BufferEncoding = "utf8"): Promise<string> {
    return fs.readFile(this.resolve(filePath), encoding);
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(this.resolve(filePath), content, "utf8");
  }

  async stat(filePath: string) {
    const s = await fs.stat(this.resolve(filePath));
    return { isDirectory: s.isDirectory(), isFile: s.isFile() };
  }

  async readdir(dirPath: string) {
    return fs.readdir(this.resolve(dirPath));
  }
}

/** RPC-backed FS when workspaceKind is remote-ssh (stub until server RPC is live). */
export class RemoteWorkspaceFs implements WorkspaceFs {
  constructor(
    private hostAlias: string,
    private remoteRoot: string,
  ) {}

  private notReady(): never {
    throw new Error(
      `Remote workspace I/O for ${this.hostAlias} is not fully connected yet. Install the Atlarix server on the host.`,
    );
  }

  readFile(): Promise<string> {
    this.notReady();
  }

  writeFile(): Promise<void> {
    this.notReady();
  }

  stat(): Promise<{ isDirectory: boolean; isFile: boolean }> {
    this.notReady();
  }

  readdir(): Promise<string[]> {
    this.notReady();
  }
}

export function parseRemoteUri(uri: string): { hostAlias: string; remotePath: string } | null {
  const m = uri.match(/^atlarix-remote:\/\/ssh\+([^/]+)(\/.*)?$/);
  if (!m) return null;
  return {
    hostAlias: decodeURIComponent(m[1]),
    remotePath: m[2] || "/",
  };
}
