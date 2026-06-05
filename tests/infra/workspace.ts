import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TempWorkspace {
  dir: string;
  write(rel: string, content: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  cleanup(): void;
}

/** Real temp directory used as the workspace (apps.path) for agent evals. */
export function makeTempWorkspace(
  seed?: Record<string, string>,
): TempWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-eval-ws-"));

  const write = (rel: string, content: string) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  for (const [rel, content] of Object.entries(seed ?? {})) {
    write(rel, content);
  }

  return {
    dir,
    write,
    read: (rel) => fs.readFileSync(path.join(dir, rel), "utf-8"),
    exists: (rel) => fs.existsSync(path.join(dir, rel)),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
