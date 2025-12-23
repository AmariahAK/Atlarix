import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

export function useFavoriteOpenRouterModels() {
    return useQuery({
        queryKey: ["favoriteOpenRouterModels"],
        queryFn: async () => {
            return await IpcClient.getInstance().getFavoriteOpenRouterModels();
        },
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}
