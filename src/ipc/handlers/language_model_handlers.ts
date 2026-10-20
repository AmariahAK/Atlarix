import type {
  LanguageModelProvider,
  LanguageModel,
  CreateCustomLanguageModelProviderParams,
  CreateCustomLanguageModelParams,
  CustomApiFormat,
  CustomAuthHeader,
} from "@/ipc/ipc_types";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import {
  CUSTOM_PROVIDER_PREFIX,
  getLanguageModelProviders,
  getLanguageModels,
  getLanguageModelsByProviders,
} from "../shared/language_model_helpers";
import { refreshModelsDev, resetModelsDevCache } from "@/lib/models_dev";
import { refreshCoreModelOverrides } from "@/lib/routing/core-model-overrides";
import { invalidateProviderModelCache } from "@/lib/provider_model_fetchers";
import { db } from "@/db";
import {
  language_models,
  language_model_providers as languageModelProvidersSchema,
  language_models as languageModelsSchema,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { IpcMainInvokeEvent } from "electron";

const logger = log.scope("language_model_handlers");
const handle = createLoggedHandler(logger);

/** A stored format, or undefined for OpenAI-compatible. Rejects anything else. */
function customApiFormat(v: unknown): CustomApiFormat | undefined {
  if (v === undefined || v === null || v === "" || v === "openai") return undefined;
  if (v === "anthropic") return v;
  throw new Error(`Unknown API format "${String(v)}"`);
}

/** A stored key header, or undefined for the format's usual one. */
function customAuthHeader(v: unknown): CustomAuthHeader | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "x-api-key" || v === "bearer") return v;
  throw new Error(`Unknown key header "${String(v)}"`);
}

export function registerLanguageModelHandlers() {
  handle(
    "get-language-model-providers",
    async (): Promise<LanguageModelProvider[]> => {
      return getLanguageModelProviders();
    },
  );

  handle(
    "create-custom-language-model-provider",
    async (
      _event: IpcMainInvokeEvent,
      params: CreateCustomLanguageModelProviderParams,
    ): Promise<LanguageModelProvider> => {
      const { id, name, apiBaseUrl, envVarName } = params;
      const apiFormat = customApiFormat(params.apiFormat);
      const authHeader = customAuthHeader(params.authHeader);

      // Validation
      if (!id) {
        throw new Error("Provider ID is required");
      }

      if (!name) {
        throw new Error("Provider name is required");
      }

      if (!apiBaseUrl) {
        throw new Error("API base URL is required");
      }

      // Check if a provider with this ID already exists. It is stored under the
      // prefix, so the bare id never matched and a duplicate failed on the
      // primary key instead of with this message.
      const existingProvider = db
        .select()
        .from(languageModelProvidersSchema)
        .where(eq(languageModelProvidersSchema.id, CUSTOM_PROVIDER_PREFIX + id))
        .get();

      if (existingProvider) {
        throw new Error(`A provider with ID "${id}" already exists`);
      }

      // Insert the new provider
      await db.insert(languageModelProvidersSchema).values({
        // Make sure we will never have accidental collisions with builtin providers
        id: CUSTOM_PROVIDER_PREFIX + id,
        name,
        api_base_url: apiBaseUrl,
        env_var_name: envVarName || null,
        api_format: apiFormat ?? null,
        auth_header: authHeader ?? null,
      });

      // Return the newly created provider
      return {
        id,
        name,
        apiBaseUrl,
        envVarName,
        ...(apiFormat ? { apiFormat } : {}),
        ...(authHeader ? { authHeader } : {}),
        type: "custom",
      };
    },
  );

  handle(
    "create-custom-language-model",
    async (
      _event: IpcMainInvokeEvent,
      params: CreateCustomLanguageModelParams,
    ): Promise<void> => {
      const {
        apiName,
        displayName,
        providerId,
        description,
        maxOutputTokens,
        contextWindow,
      } = params;

      // Validation
      if (!apiName) {
        throw new Error("Model API name is required");
      }
      if (!displayName) {
        throw new Error("Model display name is required");
      }
      if (!providerId) {
        throw new Error("Provider ID is required");
      }

      // Check if provider exists
      const providers = await getLanguageModelProviders();
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) {
        throw new Error(`Provider with ID "${providerId}" not found`);
      }

      // Insert the new model
      await db.insert(languageModelsSchema).values({
        displayName,
        apiName,
        builtinProviderId: provider.type === "cloud" ? providerId : undefined,
        customProviderId: provider.type === "custom" ? providerId : undefined,
        description: description || null,
        max_output_tokens: maxOutputTokens || null,
        context_window: contextWindow || null,
      });
    },
  );
  handle(
    "edit-custom-language-model-provider",
    async (
      _event: IpcMainInvokeEvent,
      params: CreateCustomLanguageModelProviderParams,
    ): Promise<LanguageModelProvider> => {
      const { id, name, apiBaseUrl, envVarName } = params;
      // Left out = unchanged: the CLI and editor edit only the base URL.
      const formatGiven = params.apiFormat !== undefined;
      const headerGiven = params.authHeader !== undefined;
      const apiFormat = customApiFormat(params.apiFormat);
      const authHeader = customAuthHeader(params.authHeader);

      if (!id) {
        throw new Error("Provider ID is required");
      }
      if (!name) {
        throw new Error("Provider name is required");
      }
      if (!apiBaseUrl) {
        throw new Error("API base URL is required");
      }

      // Check if the provider being edited exists
      const existingProvider = db
        .select()
        .from(languageModelProvidersSchema)
        .where(eq(languageModelProvidersSchema.id, CUSTOM_PROVIDER_PREFIX + id))
        .get();

      if (!existingProvider) {
        throw new Error(`Provider with ID "${id}" not found`);
      }

      // Use transaction to ensure atomicity when updating provider and potentially its models
      const result = db.transaction((tx) => {
        // Update the provider
        const updateResult = tx
          .update(languageModelProvidersSchema)
          .set({
            id: CUSTOM_PROVIDER_PREFIX + id,
            name,
            api_base_url: apiBaseUrl,
            env_var_name: envVarName || null,
            ...(formatGiven ? { api_format: apiFormat ?? null } : {}),
            // A new format starts from its own usual header unless one is given.
            ...(headerGiven
              ? { auth_header: authHeader ?? null }
              : formatGiven &&
                  (apiFormat ?? "openai") !== (existingProvider.api_format ?? "openai")
                ? { auth_header: null }
                : {}),
          })
          .where(
            eq(languageModelProvidersSchema.id, CUSTOM_PROVIDER_PREFIX + id),
          )
          .run();

        if (updateResult.changes === 0) {
          throw new Error(`Failed to update provider with ID "${id}"`);
        }

        return {
          id,
          name,
          apiBaseUrl,
          envVarName,
          type: "custom" as const,
        };
      });
      logger.info(`Successfully updated provider`);
      return result;
    },
  );

  handle(
    "delete-custom-language-model",
    async (
      _event: IpcMainInvokeEvent,
      params: { modelId: string },
    ): Promise<void> => {
      const { modelId: apiName } = params;

      // Validation
      if (!apiName) {
        throw new Error("Model API name (modelId) is required");
      }

      logger.info(
        `Handling delete-custom-language-model for apiName: ${apiName}`,
      );

      const existingModel = await db
        .select()
        .from(languageModelsSchema)
        .where(eq(languageModelsSchema.apiName, apiName))
        .get();

      if (!existingModel) {
        throw new Error(
          `A model with API name (modelId) "${apiName}" was not found`,
        );
      }

      await db
        .delete(languageModelsSchema)
        .where(eq(languageModelsSchema.apiName, apiName));
    },
  );

  handle(
    "delete-custom-model",
    async (
      _event: IpcMainInvokeEvent,
      params: { providerId: string; modelApiName: string },
    ): Promise<void> => {
      const { providerId, modelApiName } = params;
      logger.info(
        `Handling delete-custom-model for ${providerId} / ${modelApiName}`,
      );
      if (!providerId || !modelApiName) {
        throw new Error("Provider ID and Model API Name are required.");
      }
      logger.info(
        `Attempting to delete custom model ${modelApiName} for provider ${providerId}`,
      );

      const providers = await getLanguageModelProviders();
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) {
        throw new Error(`Provider with ID "${providerId}" not found`);
      }
      if (provider.type === "local") {
        throw new Error("Local models cannot be deleted");
      }
      const result = db
        .delete(language_models)
        .where(
          and(
            provider.type === "cloud"
              ? eq(language_models.builtinProviderId, providerId)
              : eq(language_models.customProviderId, providerId),

            eq(language_models.apiName, modelApiName),
          ),
        )
        .run();

      if (result.changes === 0) {
        logger.warn(
          `No custom model found matching providerId=${providerId} and apiName=${modelApiName} for deletion.`,
        );
      } else {
        logger.info(
          `Successfully deleted ${result.changes} custom model(s) with apiName=${modelApiName} for provider=${providerId}`,
        );
      }
    },
  );

  handle(
    "delete-custom-language-model-provider",
    async (
      _event: IpcMainInvokeEvent,
      params: { providerId: string },
    ): Promise<void> => {
      const { providerId } = params;

      // Validation
      if (!providerId) {
        throw new Error("Provider ID is required");
      }

      logger.info(
        `Handling delete-custom-language-model-provider for providerId: ${providerId}`,
      );

      // Check if the provider exists before attempting deletion
      const existingProvider = await db
        .select({ id: languageModelProvidersSchema.id })
        .from(languageModelProvidersSchema)
        .where(eq(languageModelProvidersSchema.id, providerId))
        .get();

      if (!existingProvider) {
        // If the provider doesn't exist, maybe it was already deleted. Log and return.
        logger.warn(
          `Provider with ID "${providerId}" not found. It might have been deleted already.`,
        );
        // Optionally, throw new Error(`Provider with ID "${providerId}" not found`);
        // Deciding to return gracefully instead of throwing an error if not found.
        return;
      }

      // Use a transaction to ensure atomicity
      db.transaction((tx) => {
        // 1. Delete associated models
        const deleteModelsResult = tx
          .delete(languageModelsSchema)
          .where(eq(languageModelsSchema.customProviderId, providerId))
          .run();
        logger.info(
          `Deleted ${deleteModelsResult.changes} model(s) associated with provider ${providerId}`,
        );

        // 2. Delete the provider
        const deleteProviderResult = tx
          .delete(languageModelProvidersSchema)
          .where(eq(languageModelProvidersSchema.id, providerId))
          .run();

        if (deleteProviderResult.changes === 0) {
          // This case should ideally not happen if existingProvider check passed,
          // but adding safety check within transaction.
          logger.error(
            `Failed to delete provider with ID "${providerId}" during transaction, although it was found initially. Rolling back.`,
          );
          throw new Error(
            `Failed to delete provider with ID "${providerId}" which should have existed.`,
          );
        }
        logger.info(`Successfully deleted provider with ID "${providerId}".`);
      });
      // Its key and settings go too, and any left by earlier deletes: they
      // used to stay in user-settings.json for good.
      try {
        const remaining = await db.select({ id: languageModelProvidersSchema.id }).from(languageModelProvidersSchema);
        const { pruneCustomProviderSettings } = await import("@/main/settings");
        const gone = pruneCustomProviderSettings(new Set(remaining.map((r) => r.id)));
        if (gone.length) logger.info(`Removed saved settings of deleted provider(s): ${gone.join(", ")}`);
      } catch (e) {
        logger.warn("could not remove a deleted provider's saved settings:", e);
      }
    },
  );

  handle(
    "get-language-models",
    async (
      _event: IpcMainInvokeEvent,
      params: { providerId: string },
    ): Promise<LanguageModel[]> => {
      if (!params || typeof params.providerId !== "string") {
        throw new Error("Invalid parameters: providerId (string) is required.");
      }
      const providers = await getLanguageModelProviders();
      const provider = providers.find((p) => p.id === params.providerId);
      // Gone (deleted, or a stale selection names it): it has no models. Its own
      // settings page asks again right after the delete, and this threw
      // (Sentry ATLARIX-2Z, "custom::oai-list").
      if (!provider) return [];
      if (provider.type === "local") {
        throw new Error("Local models cannot be fetched");
      }
      return getLanguageModels({ providerId: params.providerId });
    },
  );

  handle(
    "get-language-models-by-providers",
    async (): Promise<Record<string, LanguageModel[]>> => {
      return getLanguageModelsByProviders();
    },
  );

  // Does the saved key for this provider work? One authenticated GET of its
  // model list (lib/provider-key-check, as the CLI and editor do). The app's
  // provider page said "Setup Complete" for any saved key, unchecked (QA #24).
  handle(
    "providers:check-key",
    async (
      _event: IpcMainInvokeEvent,
      providerId: string,
      /** A key about to be saved, checked first: a refused one is never saved (QA). */
      candidate?: string,
    ): Promise<{ status: string; detail: string } | null> => {
      const { readSettings } = await import("@/main/settings");
      const key =
        candidate?.trim() ||
        (
          readSettings() as {
            providerSettings?: Record<string, { apiKey?: { value?: string } }>;
          }
        ).providerSettings?.[providerId]?.apiKey?.value;
      const { getLanguageModelProviders } = await import(
        "@/ipc/shared/language_model_helpers"
      );
      const p = (await getLanguageModelProviders()).find(
        (x) => x.id === providerId,
      );
      // A provider the user added may need no key (a local server): check it
      // keyless rather than calling it "Not Setup" (QA #25).
      // An Anthropic-format endpoint always takes a key: none saved yet is
      // "no key", not a red rejection of the stand-in (QA).
      if (!key && (p?.type !== "custom" || p.apiFormat === "anthropic")) return null;
      const { keyProbe, checkProviderKey, detectAnthropicAuth } = await import(
        "@/lib/provider-key-check"
      );
      // An Anthropic-format endpoint takes the key as `x-api-key` or as a
      // Bearer token: asked on every check (a new key may want the other
      // one), and the header that worked is kept.
      if (p?.apiFormat === "anthropic" && p.apiBaseUrl && key) {
        const found = await detectAnthropicAuth(p.apiBaseUrl, key);
        if (found.check.status !== "rejected" && found.authHeader !== (p.authHeader ?? "x-api-key")) {
          db.update(languageModelProvidersSchema)
            .set({ auth_header: found.authHeader })
            .where(eq(languageModelProvidersSchema.id, providerId))
            .run();
          invalidateProviderModelCache(providerId);
        }
        return found.check;
      }
      return checkProviderKey(
        keyProbe(
          providerId,
          key || "none",
          p?.apiBaseUrl ?? null,
          p?.type === "custom"
            ? { apiFormat: p.apiFormat, authHeader: p.authHeader }
            : undefined,
        ),
        key || "none",
      );
    },
  );

  handle("models-dev:refresh", async (): Promise<{ success: boolean }> => {
    try {
      invalidateProviderModelCache();
      resetModelsDevCache();
      await refreshModelsDev({ notify: true });
      return { success: true };
    } catch (e) {
      logger.warn("models-dev refresh failed", e);
      return { success: false };
    }
  });

  // Force a re-fetch of the hosted Core-tier model overrides (core-models.json).
  handle("core-models:refresh", async (): Promise<{ success: boolean }> => {
    try {
      await refreshCoreModelOverrides();
      return { success: true };
    } catch (e) {
      logger.warn("core-models refresh failed", e);
      return { success: false };
    }
  });
}
