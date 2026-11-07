/**
 * W13: a turn that opens with thoughts and tool calls streams in the list's
 * FOOTER until the reply's first text arrives (the assistant row does not exist
 * yet). Virtuoso follows a growing item but not a growing footer: once the
 * footer outgrew the bottom margin the view stayed put, "Jump to latest" showed,
 * and the sub-agent cards and approvals ran below the fold with nobody having
 * scrolled. Footer growth while you are at the bottom keeps you there; while
 * you are scrolled up to read, it leaves you where you are.
 */
import React, { forwardRef, type ComponentType } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { Message } from "@/ipc/ipc_types";

// A scroller with real-looking geometry (jsdom has no layout).
let scrollHeight = 0;
const scroller = document.createElement("div");
Object.defineProperty(scroller, "scrollHeight", { get: () => scrollHeight });
Object.defineProperty(scroller, "clientHeight", { get: () => 500 });

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(
    (
      props: {
        components?: { Footer?: ComponentType<{ context?: unknown }> };
        context?: unknown;
        scrollerRef?: (el: HTMLElement | null) => void;
      },
      _ref,
    ) => {
      props.scrollerRef?.(scroller);
      const Footer = props.components?.Footer;
      return <div>{Footer ? <Footer context={props.context} /> : null}</div>;
    },
  ),
}));
vi.mock("@/components/SimpleMessage", () => ({ SimpleMessage: () => null }));
vi.mock("@/components/chat/InlineStreamStatus", () => ({
  InlineStreamStatus: () => null,
}));
vi.mock("@/components/chat/InlineUserQuestions", () => ({
  InlineUserQuestions: () => null,
}));
vi.mock("@/components/chat/BackgroundJobsIndicator", () => ({
  BackgroundJobsIndicator: () => null,
}));
vi.mock("@/components/chat/SessionRecap", () => ({ SessionRecap: () => null }));

import { VirtualizedMessageList } from "@/components/VirtualizedMessageList";

// ResizeObserver stand-in: the test decides when a resize is reported.
const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
class FakeResizeObserver {
  private entry: { cb: ResizeObserverCallback; targets: Element[] };
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, targets: [] };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.entry.targets = [];
  }
}

let footerHeight = 0;
let footer: Element | undefined;
function grow(footerTo: number, listTo: number) {
  footerHeight = footerTo;
  scrollHeight = listTo;
  for (const o of observers) {
    if (o.targets.includes(footer!)) o.cb([], o as unknown as ResizeObserver);
  }
}

const m = (id: number, role: string) =>
  ({ id, role, content: `m${id}` }) as unknown as Message;

function streamingInFooter() {
  return render(
    <VirtualizedMessageList
      messages={[m(1, "user")]}
      chatId={7}
      workspaceAppId={null}
      isStreaming
      lastAssistantIndex={-1}
      onEditUserMessage={async () => {}}
      onContinue={() => {}}
    />,
  );
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this === footer ? footerHeight : 0;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a turn streaming in the footer", () => {
  function mount() {
    footerHeight = 200;
    scrollHeight = 1000;
    const view = streamingInFooter();
    footer = observers.flatMap((o) => o.targets)[0];
    expect(footer).toBeDefined();
    return view;
  }

  it("keeps the view at the bottom when the footer grows by a big block", () => {
    mount();
    scroller.scrollTop = 500; // at the bottom: 1000 - 500 - 500 = 0
    act(() => grow(800, 1600));
    expect(scroller.scrollTop).toBe(1600);
  });

  it("keeps following growth after growth", () => {
    mount();
    scroller.scrollTop = 500;
    act(() => grow(800, 1600));
    scroller.scrollTop = 1100; // where the browser clamps the pin
    act(() => grow(1400, 2200));
    expect(scroller.scrollTop).toBe(2200);
  });

  it("leaves you where you are when you scrolled up to read", () => {
    mount();
    scroller.scrollTop = 100; // 400px above the bottom
    act(() => grow(800, 1600));
    expect(scroller.scrollTop).toBe(100);
  });
});
