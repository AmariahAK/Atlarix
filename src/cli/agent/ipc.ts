/**
 * The main-process IPC handlers the CLI drives in-process: registered by the
 * desktop's own `register*Handlers()` against the electron stub's ipcMain, and
 * called here with a fake event — the same code paths the app's renderer uses.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (event: any, ...args: any[]) => Promise<any> | any;

/** A handler the main-process code registered (recorded by the electron stub's ipcMain). */
export async function handler(channel: string): Promise<Handler> {
  const electron = (await import("electron")) as unknown as {
    getRegisteredHandler?: (c: string) => Handler | undefined;
  };
  const h = electron.getRegisteredHandler?.(channel);
  if (!h) throw new Error(`No handler registered for ${channel}`);
  return h;
}

/** Call a handler with no window behind it. */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return (await (await handler(channel))({}, ...args)) as T;
}
