import log from "electron-log";

const logger = log.scope("ssh_session");

export type SshConnectionState = {
  hostAlias: string;
  connected: boolean;
  localPort?: number;
  error?: string;
};

const sessions = new Map<string, SshConnectionState>();

export function getSshSession(hostAlias: string): SshConnectionState | undefined {
  return sessions.get(hostAlias);
}

export async function connectSshHost(hostAlias: string): Promise<SshConnectionState> {
  logger.log(`Connecting SSH host: ${hostAlias}`);
  const state: SshConnectionState = {
    hostAlias,
    connected: true,
    localPort: 0,
  };
  sessions.set(hostAlias, state);
  return state;
}

export async function disconnectSshHost(hostAlias: string): Promise<void> {
  sessions.delete(hostAlias);
}

export async function testSshHost(hostAlias: string): Promise<{ ok: boolean; message: string }> {
  if (!hostAlias.trim()) {
    return { ok: false, message: "Host alias is required." };
  }
  return { ok: true, message: `Host ${hostAlias} is reachable (stub). Full SSH in a future build.` };
}
