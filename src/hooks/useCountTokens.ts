import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { TokenCountResult } from "@/ipc/ipc_types";
import { useCallback, useEffect, useState } from "react";
import { useWorkModeSelection } from "./useWorkModeSelection";

export const TOKEN_COUNT_QUERY_KEY = ["tokenCount"] as const;

export function useCountTokens(chatId: number | null, input: string = "") {
  const queryClient = useQueryClient();

  /**
   * The mode the next turn will run in, sent so the main process meters the
   * prompt the next turn will actually get.
   *
   * Read here rather than passed in by each caller, for the same reason
   * `resolveSelectedWorkMode` exists: the composer and the meter must not
   * resolve the mode two different ways. It is part of the query key because the
   * fixed prefix genuinely differs per mode — Build binds ~29 tools where Plan
   * binds ~24 — so a mode switch has to refetch, not read a stale count.
   */
  const { workMode } = useWorkModeSelection();

  // Debounce input so we don't call the token counting IPC on every keystroke.
  const [debouncedInput, setDebouncedInput] = useState(input);

  useEffect(() => {
    // If there's no chat, don't bother debouncing
    if (chatId === null) {
      setDebouncedInput(input);
      return;
    }

    const debounceMs = chatId < 0 ? 2_500 : 1_000;
    const handle = setTimeout(() => {
      setDebouncedInput(input);
    }, debounceMs);

    return () => clearTimeout(handle);
  }, [chatId, input]);

  const {
    data: result = null,
    isLoading: loading,
    error,
    refetch,
  } = useQuery<TokenCountResult | null>({
    queryKey: [...TOKEN_COUNT_QUERY_KEY, chatId, debouncedInput, workMode],
    queryFn: async () => {
      if (chatId === null) return null;
      return IpcClient.getInstance().countTokens({
        chatId,
        input: debouncedInput,
        workMode,
      });
    },
    placeholderData: keepPreviousData,
    enabled: chatId !== null,
    refetchOnWindowFocus: false,
    staleTime: chatId != null && chatId < 0 ? 5_000 : 0,
  });

  // For imperative invalidation (e.g., after streaming completes)
  const invalidateTokenCount = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
  }, [queryClient]);

  return {
    result,
    loading,
    error,
    refetch,
    invalidateTokenCount,
  };
}

/**
 * PASS8 E3: Context-only token-count helper.
 * Callers that do not need the live composer input (`MessagesList`,
 * `ChatInputControls`, `useStreamChat`) should use this hook so they all
 * share the same React-Query cache key `["tokenCount", chatId, ""]`. TanStack
 * Query already dedupes identical keys, so a single IPC call serves every
 * subscriber — this wrapper exists to make that intent explicit and to keep
 * a single chokepoint if the dedup strategy needs to change.
 */
export function useContextTokenCount(chatId: number | null) {
  return useCountTokens(chatId, "");
}
