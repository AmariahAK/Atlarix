import { useState, useEffect, useCallback, useRef } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import type { ProposalResult } from "@/lib/schemas"; // Import Proposal type
import { proposalResultAtom } from "@/atoms/proposalAtoms";
import { useAtom } from "jotai";

export function useProposal(chatId?: number | undefined) {
  const [proposalResult, setProposalResult] = useAtom(proposalResultAtom);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // Mirror of the current atom value so the write guard can compare without
  // adding `proposalResult` to fetchProposal's deps (which would re-create the
  // callback on every fetch and re-arm the effect — the React #185 loop).
  const resultRef = useRef<ProposalResult | null>(proposalResult);
  resultRef.current = proposalResult;

  const fetchProposal = useCallback(
    async (overrideChatId?: number) => {
      // Use a LOCAL id — never reassign the captured `chatId` param (mutating it
      // confused the dependency identity and helped drive an update loop).
      const id = overrideChatId ?? chatId;
      if (id === undefined) {
        if (resultRef.current !== null) setProposalResult(null);
        setIsLoading(false);
        setError(null);
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const result = (await IpcClient.getInstance().getProposal(
          id,
        )) as ProposalResult | null;
        const next = result ?? null;
        // Skip the atom write when nothing actually changed. getProposal returns
        // a fresh object every call, so writing unconditionally notified every
        // subscriber on each fetch — the engine behind the render storm.
        if (!proposalsEqual(next, resultRef.current)) {
          setProposalResult(next);
        }
      } catch (err: any) {
        console.error("Error fetching proposal:", err);
        setError(err?.message || "Failed to fetch proposal");
        if (resultRef.current !== null) setProposalResult(null);
      } finally {
        setIsLoading(false);
      }
    },
    // setProposalResult is stable (jotai). Intentionally NOT depending on
    // proposalResult — the ref handles equality.
    [chatId, setProposalResult],
  );

  // Fetch only when chatId actually changes — NOT when fetchProposal identity
  // churns. Depending on [fetchProposal] (which depends on chatId) re-ran the
  // effect → setProposalResult → re-render → ... → "Maximum update depth".
  useEffect(() => {
    void fetchProposal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  return {
    proposalResult: proposalResult,
    isLoading,
    error,
    refreshProposal: fetchProposal, // Expose the refresh function
  };
}

/** Cheap structural equality for a plain IPC-serializable proposal result. */
function proposalsEqual(
  a: ProposalResult | null,
  b: ProposalResult | null,
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
