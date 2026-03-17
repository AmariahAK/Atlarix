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
import { IpcClient } from "./ipc/ipc_client";
import { DevServerProvider } from "./components/DevServerProvider";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { useDbReady } from "./hooks/useDbReady";
import * as Sentry from "@sentry/electron/renderer";

// @ts-ignore
console.log("Running in mode:", import.meta.env.MODE);

let sentryIsPackaged = true; // set by bootstrap before render

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

  return <RouterProvider router={router} />;
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
