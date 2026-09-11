/**
 * The Chrome extension API surface Atlarix actually uses — declared by hand.
 *
 * WHY NOT `@types/chrome`. That package declares the whole platform, and a type
 * for an API we never call is an invitation to call it. This file is the
 * inverse: every entry here is something the extension genuinely needs, so it
 * doubles as the justification list for the Web Store permissions review and as
 * the thing to re-read when someone asks "why does this want `debugger`?".
 *
 * Adding to this file is a deliberate act. It should come with the reason.
 */

declare namespace chrome {
  namespace runtime {
    const id: string;
    const lastError: { message?: string } | undefined;
    function getURL(path: string): string;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(
        cb: (
          message: unknown,
          sender: { tab?: tabs.Tab; id?: string },
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  }

  namespace identity {
    /** OAuth: the PKCE flow runs here, redirecting to <id>.chromiumapp.org. */
    function launchWebAuthFlow(details: {
      url: string;
      interactive: boolean;
    }): Promise<string | undefined>;
    function getRedirectURL(path?: string): string;
  }

  namespace storage {
    interface StorageArea {
      get<T = Record<string, unknown>>(
        keys?: string | string[] | null,
      ): Promise<T>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }
    /** Site grants live here: they are a browser-profile setting. */
    const sync: StorageArea;
    /** The Supabase session and raw page reads live here — device-local. */
    const local: StorageArea;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      windowId?: number;
      groupId?: number;
      url?: string;
      title?: string;
      active?: boolean;
      index?: number;
    }
    function create(props: {
      url?: string;
      active?: boolean;
      windowId?: number;
      index?: number;
    }): Promise<Tab>;
    function get(tabId: number): Promise<Tab>;
    function query(info: {
      active?: boolean;
      currentWindow?: boolean;
      windowId?: number;
      groupId?: number;
    }): Promise<Tab[]>;
    function remove(tabIds: number | number[]): Promise<void>;
    function group(options: {
      tabIds: number | number[];
      groupId?: number;
      createProperties?: { windowId?: number };
    }): Promise<number>;
    function ungroup(tabIds: number | number[]): Promise<void>;
    const onRemoved: {
      addListener(cb: (tabId: number) => void): void;
    };
  }

  namespace tabGroups {
    /** `-1`. A tab that belongs to no group. */
    const TAB_GROUP_ID_NONE: number;
    type Color =
      | "grey"
      | "blue"
      | "red"
      | "yellow"
      | "green"
      | "pink"
      | "purple"
      | "cyan"
      | "orange";
    interface TabGroup {
      id: number;
      title?: string;
      color: Color;
      collapsed: boolean;
      windowId: number;
    }
    function get(groupId: number): Promise<TabGroup>;
    /** The group's title is where the running model's name is shown. */
    function update(
      groupId: number,
      props: { title?: string; color?: Color; collapsed?: boolean },
    ): Promise<TabGroup>;
    const onRemoved: {
      addListener(cb: (group: TabGroup) => void): void;
    };
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number;
      allFrames?: boolean;
    }
    /**
     * Runs the shared page-realm scripts. `world: "MAIN"` is required: the ref
     * registry is a WeakMap on `window`, and an isolated world would give every
     * read a fresh, empty one.
     */
    function executeScript<T = unknown>(injection: {
      target: InjectionTarget;
      func?: (...args: never[]) => T;
      args?: unknown[];
      files?: string[];
      world?: "ISOLATED" | "MAIN";
    }): Promise<Array<{ frameId: number; result: T }>>;
  }

  // `debugger` is a reserved word and cannot name a namespace. It is declared
  // under an alias here and surfaced as `debugger` on the `ExtensionApi`
  // interface in ../shared/browser-api.ts, where a keyword IS a legal property
  // name. Re-exporting it under the real name instead turns this ambient
  // namespace export-restricted, which hides every other member from
  // `typeof chrome` — an error that points at `storage`, not at this.
  namespace _debugger {
    interface Debuggee {
      tabId?: number;
    }
    /**
     * Trusted input ONLY. `browser.ts:1173` records why nothing else will do:
     * Enter-to-submit and CSS `:hover` fire for trusted events alone, and a
     * synthetic KeyboardEvent "looks right in code and silently does nothing".
     *
     * Attached per-tab, and only to tabs inside the agent's own group, so the
     * user's other tabs keep their DevTools and show no banner.
     */
    function attach(target: Debuggee, requiredVersion: string): Promise<void>;
    function detach(target: Debuggee): Promise<void>;
    function sendCommand<T = unknown>(
      target: Debuggee,
      method: string,
      commandParams?: Record<string, unknown>,
    ): Promise<T>;
    /** The user can click Cancel on the banner — this is a normal path. */
    const onDetach: {
      addListener(cb: (source: Debuggee, reason: string) => void): void;
    };
  }

  namespace offscreen {
    type Reason = "DOM_PARSER" | "BLOBS" | "WORKERS" | "DOM_SCRAPING";
    function createDocument(params: {
      url: string;
      reasons: Reason[];
      justification: string;
    }): Promise<void>;
    function closeDocument(): Promise<void>;
    function hasDocument(): Promise<boolean>;
  }

  namespace sidePanel {
    function setPanelBehavior(behavior: {
      openPanelOnActionClick: boolean;
    }): Promise<void>;
    function open(options: {
      windowId?: number;
      tabId?: number;
    }): Promise<void>;
  }

  namespace windows {
    const WINDOW_ID_NONE: number;
    function getCurrent(): Promise<{ id?: number }>;
  }
}
