/**
 * A notification must stay reachable until it is finished.
 *
 * This is the fix for a `SIGSEGV / SI_KERNEL / 0x0` in
 * `electron::NotificationPresenter::RemoveNotification` — a native crash in the
 * BROWSER process, so nothing in JS could catch it and the whole app went down.
 * Every call site dropped its reference the instant `show()` returned, letting
 * V8 collect the wrapper while the OS notification was still on screen; the
 * resulting teardown races the notification daemon's own.
 *
 * The invariant is narrow and easy to break silently — nothing reads the set, so
 * a missing release leaks and an early release crashes, and neither shows up
 * anywhere else. Hence a test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = () => void;

class FakeNotification {
  static supported = true;
  static instances: FakeNotification[] = [];
  shown = false;
  private once = new Map<string, Handler>();
  private on = new Map<string, Handler>();

  constructor(
    public options: { title: string; body: string; silent?: boolean },
  ) {
    FakeNotification.instances.push(this);
  }
  static isSupported() {
    return FakeNotification.supported;
  }
  show() {
    this.shown = true;
  }
  emit(event: string) {
    this.once.get(event)?.();
    this.on.get(event)?.();
  }
  addOnce(event: string, fn: Handler) {
    this.once.set(event, fn);
    return this;
  }
  addOn(event: string, fn: Handler) {
    this.on.set(event, fn);
    return this;
  }
}

vi.mock("electron", () => ({
  Notification: Object.assign(
    class {
      constructor(options: { title: string; body: string; silent?: boolean }) {
        const inst = new FakeNotification(options);
        return {
          show: () => inst.show(),
          once: (e: string, fn: Handler) => inst.addOnce(e, fn),
          on: (e: string, fn: Handler) => inst.addOn(e, fn),
        } as unknown as FakeNotification;
      }
    },
    { isSupported: () => FakeNotification.isSupported() },
  ),
}));

const { showDesktopNotification, liveNotificationCount } = await import(
  "@/main/desktop-notification"
);

beforeEach(() => {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
});

afterEach(() => {
  // The held set is module state. Close everything this test opened, which is
  // what happens in reality and leaves the count where the next test expects it.
  for (const n of FakeNotification.instances) n.emit("close");
  expect(liveNotificationCount()).toBe(0);
});

describe("desktop notification lifetime", () => {
  it("holds a reference after show, so GC cannot tear it down mid-flight", async () => {
    await showDesktopNotification({ title: "t", body: "b" });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].shown).toBe(true);
    expect(liveNotificationCount()).toBe(1);
  });

  it("releases when the notification closes", async () => {
    await showDesktopNotification({ title: "t", body: "b" });
    FakeNotification.instances[0].emit("close");
    expect(liveNotificationCount()).toBe(0);
  });

  it("releases when the OS refuses it — otherwise this leaks instead of crashing", async () => {
    await showDesktopNotification({ title: "t", body: "b" });
    FakeNotification.instances[0].emit("failed");
    expect(liveNotificationCount()).toBe(0);
  });

  it("does nothing on a platform with no presenter", async () => {
    // A Linux box with no notification daemon. The Linux-only updater
    // notification skipped this check entirely before.
    FakeNotification.supported = false;
    await showDesktopNotification({ title: "t", body: "b" });
    expect(FakeNotification.instances).toHaveLength(0);
    expect(liveNotificationCount()).toBe(0);
  });

  it("a throwing click handler does not escape into the browser process", async () => {
    await showDesktopNotification({
      title: "t",
      body: "b",
      onClick: () => {
        throw new Error("bad handler");
      },
    });
    expect(() => FakeNotification.instances[0].emit("click")).not.toThrow();
    // And it is still held — a click is not the end of a notification.
    expect(liveNotificationCount()).toBe(1);
  });

  it("truncates the body rather than handing the OS an unbounded string", async () => {
    await showDesktopNotification({ title: "t", body: "x".repeat(500) });
    expect(FakeNotification.instances[0].options.body).toHaveLength(140);
  });
});
