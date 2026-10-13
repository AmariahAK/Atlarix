import { LargeLanguageModel } from "@/lib/schemas";
import { LanguageModel } from "../ipc_types";
import { getLanguageModels } from "../shared/language_model_helpers";

export async function findLanguageModel(
  model: LargeLanguageModel,
): Promise<LanguageModel | undefined> {
  // Several calls per turn: look in what's stored first, and ask a provider's
  // endpoint (a provider you added) only when the model isn't there.
  const stored = await getLanguageModels({
    providerId: model.provider,
    live: false,
  });
  const found = pick(stored, model);
  if (found || !model.provider.startsWith("custom::")) return found;
  return pick(
    await getLanguageModels({ providerId: model.provider }),
    model,
  );
}

function pick(
  models: LanguageModel[],
  model: LargeLanguageModel,
): LanguageModel | undefined {
  if (model.customModelId) {
    const customModel = models.find(
      (m) => m.type === "custom" && m.id === model.customModelId,
    );
    if (customModel) return customModel;
  }
  return models.find((m) => m.apiName === model.name);
}
