/**
 * Renderer (jsdom) test setup — v10.1 renderer/integration coverage.
 * Component tests live under `src/__tests__/renderer/`; the IpcClient module
 * is mocked per-test via the helpers in that directory.
 */

import "@testing-library/jest-dom/vitest";
import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// PostHog's session recorder: a large side-effect bundle posthog-client imports
// at the top (the CSP blocks its CDN copy). Any component that reaches
// useSettings loads it, and on a slow CI runner the load could still be running
// when the test file's environment was torn down: 24 "EnvironmentTeardownError
// … posthog-recorder.js" on dev a2bc57eb, all tests passing. No renderer test
// records, so none loads it.
vi.mock("posthog-js/dist/posthog-recorder", () => ({}));

// xterm imports CSS + canvas APIs jsdom lacks; terminal views aren't under test.
vi.mock("@/components/panels/XtermView", () => ({
  XtermView: () => null,
  disposeXtermInstance: () => {},
}));

// jsdom has no canvas — AtlarixAnimation (compass) renders a stub that exposes
// its phase for assertions instead of drawing.
vi.mock("@/components/atlarix/AtlarixAnimation", () => ({
  default: ({ phase, size }: { phase?: string; size?: string }) => {
    const React = require("react");
    return React.createElement("div", {
      "data-testid": "atlarix-animation",
      "data-phase": phase ?? "loop",
      "data-size": size ?? "md",
    });
  },
}));

// window.matchMedia for components/styles that query color scheme.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ResizeObserver / IntersectionObserver / scrollIntoView for virtualized lists & cmdk.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
(globalThis as Record<string, unknown>).ResizeObserver = NoopObserver;
(globalThis as Record<string, unknown>).IntersectionObserver = NoopObserver;
Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView ?? (() => {});
