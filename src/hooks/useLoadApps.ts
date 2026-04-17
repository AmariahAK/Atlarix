import { useState, useEffect, useCallback } from "react";
import { useAtom } from "jotai";
import { appBasePathAtom, appsListAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import type { App } from "@/ipc/ipc_types";

type AppPathStatusPayload = {
  statuses: Array<{ id: number; pathExists: boolean; status: App["status"] }>;
};

export function useLoadApps() {
  const [apps, setApps] = useAtom(appsListAtom);
  const [, setAppBasePath] = useAtom(appBasePathAtom);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refreshApps = useCallback(async () => {
    setLoading(true);
    try {
      const ipcClient = IpcClient.getInstance();
      const appListResponse = await ipcClient.listApps();
      setApps(appListResponse.apps);
      setAppBasePath(appListResponse.appBasePath);
      setError(null);
    } catch (error) {
      console.error("Error refreshing apps:", error);
      setError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setLoading(false);
    }
  }, [setApps, setError, setLoading]);

  useEffect(() => {
    refreshApps();
  }, [refreshApps]);

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.on) return;
    const handler = (...args: unknown[]) => {
      const payload = args[0] as AppPathStatusPayload | undefined;
      const statuses = payload?.statuses;
      if (!Array.isArray(statuses) || statuses.length === 0) return;
      const byId = new Map(statuses.map((s) => [s.id, s]));
      setApps((prev) =>
        prev.map((app) => {
          const s = byId.get(app.id);
          if (!s) return app;
          return { ...app, pathExists: s.pathExists, status: s.status };
        }),
      );
    };
    ipc.on("apps:status-changed", handler);
    return () => {
      ipc.removeListener("apps:status-changed", handler);
    };
  }, [setApps]);

  return { apps, loading, error, refreshApps };
}
