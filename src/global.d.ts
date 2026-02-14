/** Electron preload-exposed API (see src/preload.ts). */
interface ElectronAPI {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  shell?: { openExternal: (url: string) => Promise<void> };
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => (() => void) | void;
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
    removeAllListeners: (channel: string) => void;
  };
  webFrame?: {
    setZoomFactor: (factor: number) => void;
    getZoomFactor: () => number;
  };
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

export {};
