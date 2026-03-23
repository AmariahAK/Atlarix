/**
 * Token Vault IPC handlers — v4.0 Workforce
 * Auth0-powered agent authentication for extensions.
 */

import { ipcMain, shell } from "electron";
import {
  getToken,
  revokeToken,
  listConnectedServices,
  setTokenVaultFallbackWarning,
  getConnectUrl,
  storeAuth0Tokens,
  clearAllTokenAuthSessions,
} from "../../lib/auth/TokenVaultService";

export function registerTokenVaultHandlers(): void {
  ipcMain.handle(
    "token-vault:get-token",
    async (_event, service: string, scopes: string[]) => {
      return getToken(service, Array.isArray(scopes) ? scopes : []);
    }
  );

  ipcMain.handle("token-vault:revoke", async (_event, service: string) => {
    await revokeToken(service);
  });

  ipcMain.handle("token-vault:list-services", async () => {
    return listConnectedServices();
  });

  ipcMain.handle("token-vault:start-connect", async (_event, service: string) => {
    const url = getConnectUrl(service);
    if (url) {
      await shell.openExternal(url);
      return { success: true, url };
    }
    return { success: false, error: "Token Vault not configured" };
  });

  ipcMain.handle(
    "token-vault:store-tokens",
    async (_event, refreshToken: string, accessToken: string, expiresInSeconds: number) => {
      storeAuth0Tokens(refreshToken, accessToken, expiresInSeconds);
      return { success: true };
    }
  );

  ipcMain.handle("token-vault:clear-all-sessions", async () => {
    clearAllTokenAuthSessions();
    return { success: true };
  });

  setTokenVaultFallbackWarning((message) => {
    const { BrowserWindow } = require("electron");
    BrowserWindow.getAllWindows().forEach((win: any) => {
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send("token-vault:fallback-warning", message);
      }
    });
  });
}
