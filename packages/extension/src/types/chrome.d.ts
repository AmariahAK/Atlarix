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
    /**
     * The parsed manifest. Needs NO permission, which is what makes it usable
     * as the ground truth for what this build asked for — `shared/browser-api.ts`
     * cross-references it so a permission we have not requested yet is never
     * reported to anyone as a capability their browser lacks.
     */
    function getManifest(): { permissions?: string[]; version?: string };
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    /**
     * Fires at browser profile launch. Registering it is what makes Chrome WAKE
     * the service worker at launch, so the desktop bridge connects before the
     * user touches anything (`background/service-worker.ts`).
     */
    const onStartup: { addListener(cb: () => void): void };
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

  /**
   * Optional host access, requested per origin at the moment the user grants a
   * site.
   *
   * THIS API NEEDS NO PERMISSION STRING of its own. Host access moved to
   * REQUIRED `host_permissions` on 2026-09-17 so the desktop app never has to
   * ask, which means `request()` for an origin the manifest already holds
   * resolves true without a prompt. It is kept because `contains()` is still
   * how we read what Chrome currently allows — a user can narrow site access
   * from chrome://extensions at any time, and Chrome does not tell us.
   *
   * `request()` REQUIRES A USER GESTURE and cannot be called from the service
   * worker, so it lives in the side panel. That is a containment property, not
   * an inconvenience: the agent loop runs in the worker and the offscreen
   * document, so it structurally cannot widen its own reach.
   */
  namespace permissions {
    interface Permissions {
      permissions?: string[];
      origins?: string[];
    }
    function contains(permissions: Permissions): Promise<boolean>;
    /** Resolves false when the user declines — it does not reject. */
    function request(permissions: Permissions): Promise<boolean>;
    function remove(permissions: Permissions): Promise<boolean>;
    /** The user can revoke from chrome://extensions at any time. */
    const onRemoved: {
      addListener(cb: (permissions: Permissions) => void): void;
    };
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
      /** "loading" | "complete". Absent until the tab has begun loading. */
      status?: string;
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
    /**
     * A PNG data URL of the ACTIVE tab of `windowId` — the visible one, and
     * only that one. Used for the user's own tab while it is on screen; the
     * agent's background tabs are captured over CDP instead.
     */
    function captureVisibleTab(
      windowId: number,
      options: { format: "png" | "jpeg"; quality?: number },
    ): Promise<string>;
    /**
     * Navigating a tab the agent already owns, rather than opening a third one
     * for every step of a flow. Restricted by its caller to tabs inside the
     * agent's group — `tabs.update` would otherwise redirect whatever tab the
     * user happens to be reading.
     */
    function update(
      tabId: number,
      props: { url?: string; active?: boolean },
    ): Promise<Tab>;
    /**
     * Waiting for a page to finish loading.
     *
     * A read issued the instant `tabs.create` resolves lands on `about:blank`
     * and returns an empty snapshot — which the model reads as "this page has
     * nothing on it" and acts on. There is no promise-shaped alternative:
     * `create` resolves when the tab EXISTS, not when it has loaded.
     */
    const onUpdated: {
      addListener(
        cb: (
          tabId: number,
          change: { status?: string; url?: string },
          tab: Tab,
        ) => void,
      ): void;
      removeListener(cb: (...args: never[]) => void): void;
    };
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
     * Trusted input ONLY. `browser.ts`, under `key / hover / scroll`, records
     * why nothing else will do:
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
    /**
     * Protocol events for every attached tab, on ONE listener.
     *
     * `Runtime.consoleAPICalled` and the `Network.*` family arrive here, which
     * is what makes console and network capture possible at all — they are
     * pushed, not polled, so a read that happens after the fact still sees what
     * the page did, provided we were attached when it did it.
     */
    const onEvent: {
      addListener(
        cb: (source: Debuggee, method: string, params?: unknown) => void,
      ): void;
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
    /** The side-panel fallback for browsers with no `sidePanel` namespace. */
    function create(options: {
      url?: string;
      type?: "normal" | "popup" | "panel";
      width?: number;
      height?: number;
      focused?: boolean;
    }): Promise<{ id?: number }>;
  }

  /**
   * The toolbar button.
   *
   * ONLY `onClicked` IS DECLARED, and only because of the side-panel fallback:
   * `onClicked` fires únicamente when the action has neither a `default_popup`
   * nor a registered panel behaviour, which is exactly the state a browser
   * without `chrome.sidePanel` leaves us in. These typings are hand-written on
   * purpose — declaring an API we do not call is a claim nobody checks.
   */
  namespace action {
    const onClicked: {
      addListener(cb: (tab: { id?: number; windowId?: number }) => void): void;
    };
  }
}
