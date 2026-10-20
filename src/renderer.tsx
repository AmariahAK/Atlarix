import { Component, StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import { RouterProvider } from "@tanstack/react-router";
import { PostHogProvider } from "posthog-js/react";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "./lib/i18n";

/** One instance for this window, created eagerly so the first paint has text.
 *  `useAppLocale` switches it once settings resolve. */
const i18n = createI18n();
import posthog from "posthog-js";
import {
  ensurePostHogInitialized,
  getPostHogClient,
  setPostHogConfig,
} from "@/lib/analytics/posthog-client";
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  MutationCache,
} from "@tanstack/react-query";
import { showError, showMcpConsentToast } from "./lib/toast";
import { McpOAuthPrompt } from "./components/McpOAuthPrompt";
import { IpcClient } from "./ipc/ipc_client";
import { DevServerProvider } from "./components/DevServerProvider";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { PerfDevOverlayHost } from "./components/dev/PerfDevOverlay";
import { useDbReady } from "./hooks/useDbReady";
import { useAuth } from "./lib/auth/useAuth";
import * as Sentry from "@sentry/electron/renderer";
import { sentryBeforeSendDropExpected } from "./lib/sentry-before-send";
import { SENTRY_IGNORE_ERROR_PATTERNS } from "./lib/sentry-ignore-patterns";
import { purgeLegacyVoiceModelCache } from "./lib/voice/purge-legacy-model-cache";

// The on-device speech engine is gone; its ~285 MB of cached weights are not,
// and nothing else would ever remove them. Fire-and-forget — it must not delay
// first paint, and there is nothing to report either way.
void purgeLegacyVoiceModelCache();

// @ts-ignore
console.log("Running in mode:", import.meta.env.MODE);

let sentryIsPackaged = true; // set by bootstrap before render

function eventRejectionDetails(reason: Event): {
  type: string;
  tagName?: string;
  src?: string;
  href?: string;
  id?: string;
  className?: string;
} {
  const target = reason.target as unknown;
  const el = target && typeof target === "object" ? (target as Element) : null;
  const tagName =
    el && "tagName" in el ? String((el as Element).tagName ?? "") : undefined;
  const src =
    el && "getAttribute" in el
      ? ((el as Element).getAttribute?.("src") ?? undefined)
      : undefined;
  const href =
    el && "getAttribute" in el
      ? ((el as Element).getAttribute?.("href") ?? undefined)
      : undefined;
  const id = el && "id" in el ? String((el as Element).id ?? "") : undefined;
  const className =
    el && "className" in el
      ? String((el as Element).className ?? "")
      : undefined;
  return { type: reason.type, tagName, src, href, id, className };
}

// Normalize Promise rejections that are `Event` objects (common for <script> load errors),
// so Sentry does not capture unhelpful `Error: [object Event]`.
window.addEventListener("unhandledrejection", (ev) => {
  const reason = (ev as PromiseRejectionEvent).reason;
  if (reason instanceof Event) {
    const d = eventRejectionDetails(reason);
    Sentry.captureMessage(
      `Unhandled promise rejection (Event): ${d.type}${d.tagName ? ` @ <${d.tagName.toLowerCase()}>` : ""}${d.src ? ` src=${d.src}` : ""}${d.href ? ` href=${d.href}` : ""}`,
      {
        level: "warning",
        tags: { kind: "event_rejection", area: "renderer" },
        extra: d,
      },
    );
    ev.preventDefault();
    return;
  }
  // Some libraries reject with plain objects/strings; normalize so Sentry gets a real message.
  if (!(reason instanceof Error)) {
    let msg = "";
    try {
      if (typeof reason === "string") msg = reason;
      else msg = JSON.stringify(reason);
    } catch {
      msg = String(reason);
    }
    if (msg && msg !== "[object Object]" && msg !== "[object Event]") {
      Sentry.captureException(
        new Error(`Unhandled promise rejection: ${msg.slice(0, 1000)}`),
        {
          level: "warning",
          tags: { kind: "non_error_rejection", area: "renderer" },
          extra: { reasonType: typeof reason },
        },
      );
      // Avoid duplicate capture from default handlers for this normalized case.
      ev.preventDefault();
    }
  }
});

interface MyMeta extends Record<string, unknown> {
  showErrorToast: boolean;
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: MyMeta;
    mutationMeta: MyMeta;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.meta?.showErrorToast) {
        showError(error);
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.showErrorToast) {
        showError(error);
      }
    },
  }),
});

/**
 * Re-identify the renderer client once the user signs in, so renderer events
 * land on the same person as main's (which switches to the Supabase user id via
 * `identifyUser`). Without this the two processes would attribute the same
 * human to two different ids — the very split the alias exists to remove.
 *
 * Main owns the `alias` call; this only follows it. `useAuth` already surfaces
 * the signed-in user to the renderer, so no new IPC is needed.
 */
function PostHogIdentityBridge() {
  const { user } = useAuth();
  useEffect(() => {
    if (!getPostHogClient() || !user?.id) return;
    if (posthog.get_distinct_id() === user.id) return;
    posthog.identify(user.id);
  }, [user?.id]);
  return null;
}

/** Shows loading screen until main process has initialized the database, then renders children. */
function DbReadyGate({ children }: { children: ReactNode }) {
  const dbReady = useDbReady();
  if (!dbReady) {
    return <AppLoadingScreen />;
  }
  return <>{children}</>;
}

function App() {
  // Dev-only: Ctrl+Shift+Alt+E sends a test message to Sentry to verify pipeline
  useEffect(() => {
    if (sentryIsPackaged) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.altKey && e.key === "E") {
        Sentry.captureMessage("test-error");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    // Subscribe to navigation state changes
    const unsubscribe = router.subscribe("onResolved", (navigation) => {
      // One event per screen change: a "navigation" event beside this one
      // counted every move twice.
      posthog.capture("$pageview", {
        path: navigation.toLocation.pathname,
      });
    });

    // Clean up subscription when component unmounts
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const ipc = IpcClient.getInstance();
    const unsubscribe = ipc.onMcpToolConsentRequest((payload) => {
      showMcpConsentToast({
        serverName: payload.serverName,
        toolName: payload.toolName,
        toolDescription: payload.toolDescription,
        inputPreview: payload.inputPreview,
        onDecision: (d) => ipc.respondToMcpConsentRequest(payload.requestId, d),
      });
    });
    return () => unsubscribe();
  }, []);

  return (
    <>
      <RouterProvider router={router} />
      <McpOAuthPrompt />
      <PerfDevOverlayHost />
    </>
  );
}

const SentryFallback = () => (
  <div style={{ padding: 24, fontFamily: "system-ui", textAlign: "center" }}>
    <p>Something went wrong. The error has been reported.</p>
  </div>
);

/** Catches React render errors and reports them to Sentry, then shows fallback UI. */
class SentryErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    Sentry.captureException(error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

async function bootstrap() {
  const ipc = IpcClient.getInstance();
  const [sentryConfig, posthogConfig] = await Promise.all([
    ipc.getSentryConfig(),
    ipc.getPostHogConfig(),
  ]);
  sentryIsPackaged = sentryConfig.isPackaged;
  if (sentryConfig.dsn) {
    Sentry.init({
      dsn: sentryConfig.dsn,
      release: sentryConfig.version,
      integrations: [Sentry.browserTracingIntegration()],
      // As in main: full tracing only in dev. 1.0 in packaged builds sent ~19k
      // spans a month that nobody reads, and 3k more were dropped as too large.
      tracesSampleRate: sentryIsPackaged ? 0.1 : 1.0,
      ignoreErrors: SENTRY_IGNORE_ERROR_PATTERNS,
      beforeSend: sentryBeforeSendDropExpected,
    });
  }
  if (posthogConfig.posthogApiKey) {
    // Held, not started. `ensurePostHogInitialized` writes nothing to this
    // device until consent exists — see posthog-client.ts for why that is not
    // the same as `before_send` dropping events.
    setPostHogConfig(posthogConfig.posthogApiKey, posthogConfig.analyticsId, sentryConfig.version);
    ensurePostHogInitialized();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <SentryErrorBoundary fallback={<SentryFallback />}>
        {/* Outside QueryClientProvider so a translated string is available to
            anything that renders during a query's loading state. The instance is
            initialised SYNCHRONOUSLY with the English catalog, so there is no
            frame where the UI shows raw keys. */}
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={queryClient}>
            <PostHogProvider client={getPostHogClient() ?? posthog}>
              <PostHogIdentityBridge />
              <DevServerProvider>
                <DbReadyGate>
                  <App />
                </DbReadyGate>
              </DevServerProvider>
            </PostHogProvider>
          </QueryClientProvider>
        </I18nextProvider>
      </SentryErrorBoundary>
    </StrictMode>,
  );
}

bootstrap();
