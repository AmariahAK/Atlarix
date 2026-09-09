import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import {
  getProviderApiKey,
  setProviderApiKey,
  deleteProviderApiKey,
  getConfiguredProviders,
} from "../shared/provider_api_keys";
import {
  toProviderApiKeyStatus,
  type ProviderApiKeyStatus,
} from "../shared/provider_api_key_mask";
import { trackModelConnected } from "../../main/lib/analytics";

const logger = log.scope("provider_api_key_handlers");
const handle = createLoggedHandler(logger);

export function registerProviderApiKeyHandlers() {
  handle(
    "provider:get-api-key",
    async (
      _,
      params: { providerId: string },
    ): Promise<ProviderApiKeyStatus> => {
      logger.log(`Getting API key for provider: ${params.providerId}`);
      const result = await getProviderApiKey(params.providerId);
      logger.log(
        `API key ${result ? "found" : "not found"} for: ${params.providerId}`,
      );
      return toProviderApiKeyStatus(result);
    },
  );

  handle(
    "provider:set-api-key",
    async (
      _,
      params: { providerId: string; apiKey: string },
    ): Promise<void> => {
      logger.log(
        `Setting API key for provider: ${params.providerId}, key length: ${params.apiKey?.length || 0}`,
      );
      await setProviderApiKey(params.providerId, params.apiKey);
      logger.log(`API key saved successfully for: ${params.providerId}`);
      // Funnel: a BYOK model is now wired up.
      trackModelConnected({ type: "byok", provider: params.providerId });
    },
  );

  handle(
    "provider:delete-api-key",
    async (_, params: { providerId: string }): Promise<void> => {
      logger.log(`Deleting API key for provider: ${params.providerId}`);
      await deleteProviderApiKey(params.providerId);
      logger.log(`API key deleted successfully for: ${params.providerId}`);
    },
  );

  handle("provider:get-configured", async (): Promise<string[]> => {
    const result = await getConfiguredProviders();
    logger.log(`Configured providers: ${result.join(", ")}`);
    return result;
  });
}
