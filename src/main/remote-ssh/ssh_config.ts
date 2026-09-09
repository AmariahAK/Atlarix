import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SshHostEntry = {
  hostAlias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
};

function parseSshConfigFile(configPath: string): SshHostEntry[] {
  if (!fs.existsSync(configPath)) return [];
  const text = fs.readFileSync(configPath, "utf8");
  const hosts: SshHostEntry[] = [];
  let current: SshHostEntry | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].replace(/^"|"$/g, "");

    if (key === "host") {
      if (current) hosts.push(current);
      current = { hostAlias: value.split(/\s+/)[0] };
      continue;
    }
    if (!current) continue;
    if (key === "hostname") current.hostName = value;
    if (key === "user") current.user = value;
    if (key === "port") current.port = Number.parseInt(value, 10);
    if (key === "identityfile")
      current.identityFile = value.replace(/^~/, os.homedir());
    if (key === "proxyjump") current.proxyJump = value;
  }
  if (current) hosts.push(current);

  return hosts.filter((h) => h.hostAlias && !h.hostAlias.includes("*"));
}

export function listSshConfigHosts(configFile?: string): SshHostEntry[] {
  const configPath =
    configFile?.trim() || path.join(os.homedir(), ".ssh", "config");
  return parseSshConfigFile(configPath);
}
