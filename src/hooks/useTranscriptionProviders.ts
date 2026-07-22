import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

export type TranscriptionProviderOption = { id: string; label: string };

export const TRANSCRIPTION_PROVIDERS_QUERY_KEY = [
  "transcriptionProviders",
] as const;

const STALE_MS = 5 * 60 * 1000;

/**
 * Transcription engines to offer in the composer. The list is derived in main
 * from (providers with a key) ∩ (providers with an audio-input model), so it
 * can't offer something that would fail at transcription time.
 */
export function useTranscriptionProviders() {
  return useQuery<TranscriptionProviderOption[], Error>({
    queryKey: TRANSCRIPTION_PROVIDERS_QUERY_KEY,
    queryFn: () => IpcClient.getInstance().listTranscriptionProviders(),
    staleTime: STALE_MS,
    gcTime: STALE_MS,
    refetchOnWindowFocus: false,
  });
}
