/**
 * Factory for Workforce extensions that use Token Vault only.
 */

import * as TokenVault from "../auth/TokenVaultService";
import type { WorkforceExtension } from "./types";

export function createWorkforceExtension(
  name: string,
  service: string,
  scopes: string[]
): WorkforceExtension {
  return {
    name,
    service,
    scopes,
    async connect(): Promise<boolean> {
      const token = await TokenVault.getToken(service, scopes);
      return token != null && token.length > 0;
    },
    async disconnect(): Promise<void> {
      await TokenVault.revokeToken(service);
    },
    async isConnected(): Promise<boolean> {
      const list = await TokenVault.listConnectedServices();
      return list.some((s) => s.name === service);
    },
  };
}
