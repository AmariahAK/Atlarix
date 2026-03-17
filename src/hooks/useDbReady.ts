import { useEffect, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";

/**
 * Returns true once the main process has signaled that the database is initialized
 * (either get-db-ready returns true on mount or we received the db-ready event).
 */
export function useDbReady(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const ipc = IpcClient.getInstance();
    let unsubscribe: (() => void) | undefined;

    ipc.getDbReady().then((isReady) => {
      if (isReady) {
        setReady(true);
        return;
      }
      unsubscribe = ipc.onDbReady(() => setReady(true));
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  return ready;
}
