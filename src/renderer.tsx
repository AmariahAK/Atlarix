import "shepherd.js/dist/css/shepherd.css";
import { Component, StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import { RouterProvider } from "@tanstack/react-router";
import { PostHogProvider } from "posthog-js/react";
import posthog from "posthog-js";
import { isTelemetryOptedIn } from "./hooks/useSettings";
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
import * as Sentry from "@sentry/electron/renderer";
import { sentryBeforeSendDropExpected } from "./lib/sentry-before-send";
import { SENTRY_IGNORE_ERROR_PATTERNS } from "./lib/sentry-ignore-patterns";

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
  const tagName = el && "tagName" in el ? String((el as Element).tagName ?? "") : undefined;
  const src =
    el && "getAttribute" in el ? (el as Element).getAttribute?.("src") ?? undefined : undefined;
  const href =
    el && "getAttribute" in el ? (el as Element).getAttribute?.("href") ?? undefined : undefined;
  const id = el && "id" in el ? String((el as Element).id ?? "") : undefined;
  const className =
    el && "className" in el ? String((el as Element).className ?? "") : undefined;
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
      Sentry.captureException(new Error(`Unhandled promise rejection: ${msg.slice(0, 1000)}`), {
        level: "warning",
        tags: { kind: "non_error_rejection", area: "renderer" },
        extra: { reasonType: typeof reason },
      });
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

// PostHog client: inited in bootstrap from main process config (API key + anonymous ID)
let posthogClient: ReturnType<typeof posthog.init> | null = null;

function initPostHogFromConfig(apiKey: string, analyticsId: string): void {
  posthogClient = posthog.init(apiKey, {
    api_host: "https://eu.i.posthog.com",
    persistence: "memory",
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    // @ts-ignore
    debug: import.meta.env.MODE === "development",
    before_send: (event) => {
      if (!isTelemetryOptedIn()) {
        return null;
      }
      if (event?.properties?.["$ip"]) {
        event.properties["$ip"] = null;
      }
      return event;
    },
  });
  posthog.identify(analyticsId);
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
      // Capture the navigation event in PostHog
      posthog.capture("navigation", {
        toPath: navigation.toLocation.pathname,
        fromPath: navigation.fromLocation?.pathname,
      });

      // Optionally capture as a standard pageview as well
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
      tracesSampleRate: 1.0,
      ignoreErrors: SENTRY_IGNORE_ERROR_PATTERNS,
      beforeSend: sentryBeforeSendDropExpected,
    });
  }
  if (posthogConfig.posthogApiKey) {
    initPostHogFromConfig(
      posthogConfig.posthogApiKey,
      posthogConfig.analyticsId,
    );
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <SentryErrorBoundary fallback={<SentryFallback />}>
        <QueryClientProvider client={queryClient}>
          <PostHogProvider client={posthogClient ?? posthog}>
            <DevServerProvider>
              <DbReadyGate>
                <App />
              </DbReadyGate>
            </DevServerProvider>
          </PostHogProvider>
        </QueryClientProvider>
      </SentryErrorBoundary>
    </StrictMode>,
  );
}

bootstrap();
