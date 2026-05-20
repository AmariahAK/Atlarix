import type { LanguageModel } from "@/ipc/ipc_types";

/** Renderer stub — model catalog is loaded in the main process via IPC. */
export async function getModelsFromModelsDev(
  _providerId: string,
): Promise<LanguageModel[]> {
  return [];
}

export async function refreshModelsDev(): Promise<void> {}

export function resetModelsDevCache(): void {}

export function startModelsDevRefresh(): void {}
