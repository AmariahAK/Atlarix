import type { ModelConnectedType } from "@/main/lib/analytics";

/**
 * What a key saved for `providerId` connects: a built-in provider (byok) or
 * one the user added (custom), whose API format is looked up only when the
 * event is actually sent.
 */
export function modelConnectedFor(providerId: string): {
  type: ModelConnectedType;
  provider: string;
  apiFormat?: () => Promise<string | undefined>;
} {
  if (!providerId.startsWith("custom::")) return { type: "byok", provider: providerId };
  return {
    type: "custom",
    provider: providerId,
    apiFormat: async () => {
      const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
      return (await getLanguageModelProviders()).find((p) => p.id === providerId)?.apiFormat;
    },
  };
}
