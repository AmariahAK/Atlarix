import type { IpcMainInvokeEvent } from "electron";
import { createLoggedHandler } from "../../ipc/handlers/safe_handle";
import log from "electron-log";
import { listSshConfigHosts } from "./ssh_config";
import {
  connectSshHost,
  disconnectSshHost,
  testSshHost,
} from "./ssh_session";
import { readSettings, writeSettings } from "../settings";

const logger = log.scope("remote_ssh_handlers");
const handle = createLoggedHandler(logger);

export function registerRemoteSshHandlers(): void {
  handle("ssh:list-hosts", async () => {
    const settings = await readSettings();
    const configFile =
      (settings as { remote?: { ssh?: { configFile?: string } } }).remote?.ssh
        ?.configFile;
    return listSshConfigHosts(configFile);
  });

  handle("ssh:connect", async (_e: IpcMainInvokeEvent, hostAlias: string) => {
    return connectSshHost(hostAlias);
  });

  handle("ssh:disconnect", async (_e: IpcMainInvokeEvent, hostAlias: string) => {
    await disconnectSshHost(hostAlias);
    return { ok: true };
  });

  handle("ssh:test-connection", async (_e: IpcMainInvokeEvent, hostAlias: string) => {
    return testSshHost(hostAlias);
  });

  handle(
    "ssh:list-remote-dir",
    async (_e: IpcMainInvokeEvent, params: { hostAlias: string; remotePath?: string }) => {
      const remotePath = params.remotePath?.trim() || "/";
      logger.log(`list-remote-dir ${params.hostAlias}:${remotePath} (stub)`);
      return {
        path: remotePath,
        entries: [] as { name: string; isDirectory: boolean }[],
      };
    },
  );

  handle(
    "ssh:update-settings",
    async (
      _e: IpcMainInvokeEvent,
      patch: { configFile?: string; allowLocalServerDownload?: boolean },
    ) => {
      const settings = await readSettings();
      const remote = (settings as Record<string, unknown>).remote as Record<string, unknown> | undefined;
      const ssh = (remote?.ssh as Record<string, unknown>) ?? {};
      await writeSettings({
        ...settings,
        remote: {
          ...remote,
          ssh: { ...ssh, ...patch },
        },
      } as never);
      return { ok: true };
    },
  );
}

export function buildRemoteWorkspaceUri(hostAlias: string, remotePath: string): string {
  const normalized = remotePath.replace(/\\/g, "/");
  return `atlarix-remote://ssh+${encodeURIComponent(hostAlias)}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}
