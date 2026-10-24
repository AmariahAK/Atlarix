import type { UserSettings } from "@/lib/schemas";

/**
 * Whether desktop notifications are on. Their own setting since 15.11.1, when
 * the app's sounds went (owner: the OS popup is the only signal). Before that
 * the switch was "play a sound", and it gated these popups too, so someone who
 * turned that off keeps getting none until they turn this on.
 */
export function desktopNotificationsOn(
  settings: Pick<UserSettings, "desktopNotifications" | "notificationSound">,
): boolean {
  return settings.desktopNotifications ?? settings.notificationSound?.enabled !== false;
}
