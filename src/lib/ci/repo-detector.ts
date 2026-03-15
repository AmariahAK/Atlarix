/**
 * Detect GitHub repo from workspace path — v3.9
 * Reads .git/config and parses [remote "origin"] url (HTTPS or SSH).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export async function detectGitHubRepo(workspacePath: string): Promise<GitHubRepo | null> {
  const configPath = path.join(workspacePath, ".git", "config");
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const match = content.match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*(.+)/);
    if (!match) return null;
    const url = match[1].trim();
    // HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
    const httpsMatch = url.match(/github\.com[/:](\w[\w.-]*)\/([\w.-]+?)(?:\.git)?$/i);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/, "") };
    }
    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:(\w[\w.-]*)\/([\w.-]+?)(?:\.git)?$/i);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/, "") };
    }
    return null;
  } catch {
    return null;
  }
}
