/**
 * Token Vault IPC handlers — v4.0 Workforce
 * Auth0-powered agent authentication for extensions.
 */

import { ipcMain } from "electron";
import {
  getToken,
  revokeToken,
  listConnectedServices,
  setTokenVaultFallbackWarning,
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

  // Fallback warning: main can send to renderer via a dedicated channel
  // (renderer subscribes to 'token-vault:fallback-warning'); we invoke the callback
  // which can be set by a handler that forwards to BrowserWindow. For now we only
  // set the callback; the app can call setTokenVaultFallbackWarning with a fn that
  // uses BrowserWindow.getAllWindows() and send('token-vault:fallback-warning', msg).
  setTokenVaultFallbackWarning((message) => {
    const { BrowserWindow } = require("electron");
    BrowserWindow.getAllWindows().forEach((win: any) => {
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send("token-vault:fallback-warning", message);
      }
    });
  });
}
