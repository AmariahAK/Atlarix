/**
 * 15.11.1 (owner): the app's sounds are gone; the OS popup is the only signal.
 * Its own setting (someone who switched the old sound off gets no popups), the
 * session it is about named in it, and a click opens that session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow } from "electron";

const settings = vi.fn((): Record<string, unknown> => ({}));
vi.mock("@/main/settings", () => ({ readSettings: () => settings() }));
const shown: Array<{ title: string; body: string; onClick?: () => void }> = [];
vi.mock("@/main/desktop-notification", () => ({
  showDesktopNotification: async (o: { title: string; body: string; onClick?: () => void }) => {
    shown.push(o);
  },
}));
vi.mock("@/db", () => ({
  db: {
    query: {
      chatSessions: {
        findFirst: async () => ({ id: "session-7", title: "Fix the login page" }),
      },
    },
  },
}));
const openSessionInApp = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/peers/main-host", () => ({ openSessionInApp }));

const { desktopNotificationsOn } = await import("@/lib/desktop-notifications");
const { showAgentNotification } = await import("@/main/agent-notification");

function windows(focused: boolean) {
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { isFocused: () => focused, isMinimized: () => false, show() {}, focus() {} },
  ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
}

beforeEach(() => {
  shown.length = 0;
  openSessionInApp.mockClear();
  settings.mockReturnValue({});
});

describe("the desktop notifications setting", () => {
  it("is on unless turned off, here or (before 15.11.1) as the sound switch", () => {
    expect(desktopNotificationsOn({})).toBe(true);
    expect(desktopNotificationsOn({ notificationSound: { enabled: false } })).toBe(false);
    expect(desktopNotificationsOn({ desktopNotifications: false })).toBe(false);
    // Turned on again with the new switch, after the sound was off.
    expect(desktopNotificationsOn({ desktopNotifications: true, notificationSound: { enabled: false } })).toBe(true);
  });

  it("someone who switched the sound off before gets no popup", async () => {
    windows(false);
    settings.mockReturnValue({ notificationSound: { enabled: false } });
    await showAgentNotification("Atlarix needs your approval", "Edit src/a.ts", { chatId: 3 });
    expect(shown).toEqual([]);
  });
});

describe("a notification about a chat", () => {
  it("names its session and opens it on click, quietly", async () => {
    windows(false);
    await showAgentNotification("Atlarix needs your approval", "Edit src/a.ts", { chatId: 3 });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: "Atlarix needs your approval", body: "Fix the login page: Edit src/a.ts" });
    shown[0]!.onClick?.();
    await vi.waitFor(() => expect(openSessionInApp).toHaveBeenCalledWith("session-7", { quiet: true }));
  });

  it("shows nothing while the app is in front (the card is on screen)", async () => {
    windows(true);
    await showAgentNotification("Atlarix needs your approval", "Edit src/a.ts", { chatId: 3 });
    expect(shown).toEqual([]);
  });
});
