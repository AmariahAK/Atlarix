import { useCallback, useEffect, useState } from "react";
import {
  SUPPORTED_LOCALES,
  LOCALE_LABELS,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { IpcClient } from "@/ipc/ipc_client";
import { showSuccess, showError } from "@/lib/toast";
// Hidden: ThinkingBudgetSelector, ReleaseChannelSelector, RuntimeModeSelector, NodePathSelector
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsWorkspaceNav } from "@/components/settings/SettingsWorkspaceNav";
import { useTheme } from "@/contexts/ThemeContext";
import { SearchSettings } from "@/components/settings/SearchSettings";
import { VoiceInputSettings } from "@/components/settings/VoiceInputSettings";
import { DiagnosticsPanel } from "@/components/settings/DiagnosticsPanel";
import {
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { ScrollableTabNav } from "@/components/ScrollableTabNav";
import {
  SlidersHorizontal,
  Stethoscope,
  Globe,
  Search,
  Bell,
  Mic,
  TriangleAlert,
} from "lucide-react";

/**
 * Settings — how the app behaves for you.
 *
 * ONE SECTION PER SCREEN, not one long scroll.
 *
 * This page was a single scroll of eleven cards with a sidebar that SCROLLED to
 * anchors, which needed ~60 lines of geometry (a scroll listener recomputing the
 * active section every frame, after an earlier IntersectionObserver attempt that
 * never ran and a detection band of exactly zero height). All of that existed to
 * answer "which section am I looking at?" — a question the router answers for
 * free.
 *
 * So each section is a route now, matching /integrations. Three things fall out:
 * a wrong path fails at COMPILE time because TanStack's `to` is a typed union,
 * the id-parity hazard disappears (there are no ids to keep in sync), and the
 * scroll-spy is deleted rather than maintained.
 *
 * Order: what this install IS (General, Diagnostics), then how it behaves
 * (Browser, Search, Notifications, Voice), then the escape hatch.
 */

const SECTIONS = [
  { to: "/settings", label: "General", icon: SlidersHorizontal },
  { to: "/settings/diagnostics", label: "Diagnostics", icon: Stethoscope },
  { to: "/settings/browser", label: "Browser", icon: Globe },
  { to: "/settings/search", label: "Search", icon: Search },
  { to: "/settings/notifications", label: "Notifications", icon: Bell },
  { to: "/settings/voice", label: "Voice input", icon: Mic },
  { to: "/settings/danger", label: "Danger zone", icon: TriangleAlert },
] as const;

function SettingsNav() {
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  return (
    <ScrollableTabNav label="Settings" className="mb-8">
      {SECTIONS.map((sec) => {
        const Icon = sec.icon;
        // Exact match for the index, prefix for children — otherwise
        // /settings/browser would also light up "General".
        const active =
          sec.to === "/settings"
            ? pathname === "/settings" || pathname === "/settings/"
            : pathname.startsWith(sec.to);
        return (
          <Link
            key={sec.to}
            to={sec.to}
            className={cn(
              "inline-flex shrink-0 whitespace-nowrap items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-primary/50 bg-primary/10 text-foreground font-medium"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {sec.label}
          </Link>
        );
      })}
    </ScrollableTabNav>
  );
}

export function SettingsLayout() {
  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="max-w-5xl mx-auto px-8 py-6 pb-20">
        <SettingsWorkspaceNav className="mb-4" />
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <SlidersHorizontal className="w-5 h-5 text-primary" aria-hidden />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Settings</h1>
        </div>
        <p className="text-muted-foreground mb-8 max-w-2xl">
          How Atlarix behaves for you. Model providers, MCP servers, Skills and
          project permissions live under{" "}
          <Link to="/integrations" className="text-primary hover:underline">
            Integrations
          </Link>
          .
        </p>

        <SettingsNav />
        <Outlet />
      </div>
    </div>
  );
}

/**
 * Browser — whether the user's own browser is connected.
 *
 * Since v14.52.0 the agent's only browser is the user's Chrome (or Edge /
 * Brave) through the Atlarix extension, so "connected, and which version" is
 * the first thing to check when browsing does not work. The browser opens the
 * connection, so this polls rather than connects.
 */
export function BrowserSettings() {
  const [status, setStatus] = useState<Awaited<
    ReturnType<IpcClient["getBridgeStatus"]>
  > | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () =>
      IpcClient.getInstance()
        .getBridgeStatus()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
    read();
    const timer = setInterval(read, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const peer = status?.browsers[status.browsers.length - 1];
  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
      <h2 className="text-lg font-medium text-foreground mb-4">Browser</h2>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The agent opens and tests pages — including your localhost dev server
          — in your own Chrome, Edge or Brave, through the free Atlarix
          extension. It works in its own tab group and never touches your tabs.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              status?.connected ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          {status == null ? (
            <span className="text-muted-foreground">Checking…</span>
          ) : !status.available ? (
            <span className="text-foreground">
              This build has no browser bridge. Reinstall Atlarix to restore it.
            </span>
          ) : status.connected ? (
            <span className="text-foreground">
              Connected
              {peer?.browser ? ` to ${peer.browser}` : ""}
              {peer?.extensionVersion
                ? ` — extension ${peer.extensionVersion}`
                : ""}
            </span>
          ) : (
            <span className="text-foreground">Not connected</span>
          )}
        </div>
        {status?.available && !status.connected ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Open your browser and make sure the Atlarix extension is
              installed. If it already is, click its icon once to wake it.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                IpcClient.getInstance().openExternalUrl(status.storeUrl)
              }
            >
              Install the extension
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SearchSettingsSection() {
  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
      <h2 className="text-lg font-medium text-foreground mb-4">Search</h2>
      <SearchSettings />
    </div>
  );
}

export function DiagnosticsSection() {
  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
      <DiagnosticsPanel />
    </div>
  );
}

export function DangerZoneSettings() {
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleResetEverything = async () => {
    setIsResetting(true);
    try {
      const ipcClient = IpcClient.getInstance();
      await ipcClient.resetAll();
      showSuccess("Successfully reset everything. Restart the application.");
    } catch (error) {
      console.error("Error resetting:", error);
      showError(
        error instanceof Error ? error.message : "An unknown error occurred",
      );
    } finally {
      setIsResetting(false);
      setIsResetDialogOpen(false);
    }
  };

  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-destructive/30">
      <h2 className="text-lg font-medium text-red-600 dark:text-red-400 mb-4">
        Danger zone
      </h2>
      <div className="space-y-4">
        <div className="flex items-start justify-between flex-col sm:flex-row sm:items-center gap-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">
              Reset everything
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              This will delete all your workspaces, diagrams, prompts, and
              settings. This action cannot be undone.
            </p>
          </div>
          <button
            onClick={() => setIsResetDialogOpen(true)}
            disabled={isResetting}
            className="rounded-md border border-transparent bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isResetting ? "Resetting..." : "Reset everything"}
          </button>
        </div>
      </div>

      <ConfirmationDialog
        isOpen={isResetDialogOpen}
        title="Reset Everything"
        message="Are you sure you want to reset everything? This will delete all your workspaces, diagrams, prompts and settings. This action cannot be undone."
        confirmText="Reset Everything"
        cancelText="Cancel"
        onConfirm={handleResetEverything}
        onCancel={() => setIsResetDialogOpen(false)}
      />
    </div>
  );
}

/**
 * DELETED from this page: `WorkflowSettings`, `McpServersCard`, `SkillsCard`,
 * `WorkspaceSettingsPointer` and `ModelsProvidersSettings`.
 *
 * All five were about things Atlarix CONNECTS TO, or the policy governing what
 * it may do there, and they now live on /integrations:
 *
 *   ModelsProvidersSettings  → pages/integrations-providers.tsx
 *   McpServersCard           → /integrations/mcp
 *   SkillsCard               → /integrations/skills
 *   WorkflowSettings         → pages/integrations-permissions.tsx
 *   the co-author trailer     → pages/integrations-co-author.tsx
 *
 * `WorkspaceSettingsPointer` was a row pointing at the per-project surface,
 * which a top-level Integrations entry in the sidebar makes unnecessary — a
 * pointer to a page that is already one click away in the nav is just another
 * card to read past.
 */

export function GeneralSettings({ appVersion }: { appVersion: string | null }) {
  const { settings, updateSettings } = useSettings();
  // First real use of the i18n catalogs. PR-A shipped the infrastructure with no
  // strings moved; the Language row's own labels are the natural first entries,
  // and the `check:i18n` ratchet is what insisted — it caught these three the
  // moment they were added as literals.
  const { t } = useTranslation("settings");
  const analyticsOptedIn = settings?.telemetryConsent === "opted_in";
  const { theme, setTheme } = useTheme();

  return (
    <div
      id="general"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">
        General Settings
      </h2>
      <div className="flex items-center text-sm text-muted-foreground mb-6">
        <span className="mr-2 font-medium">App Version:</span>
        <span className="bg-muted px-2 py-0.5 rounded text-foreground font-mono">
          {appVersion ? appVersion : "-"}
        </span>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <label
              htmlFor="help-improve-atlarix"
              className="text-sm font-medium text-foreground"
            >
              Help improve Atlarix
            </label>
            <p className="text-xs text-muted-foreground">
              Share usage data — which features get used, and whether things
              work — to help us understand what matters most. Never your code,
              prompts, file names, or file contents. Anonymous when signed out.
              When signed in, it's linked to your account and includes your
              email and name, so your usage counts once across your devices.
              Includes your approximate location (country and city), worked out
              from your connection; the address itself isn't kept. Crash and
              error reports are sent separately and are not covered by
              this choice — they carry stack traces and device info, never your
              code or prompts. Signed-in accounts also record which Atlarix you
              use (app, CLI, editor), the provider type and model, and how many
              turns — never prompts, code or keys — and this is not covered by
              this choice either.
            </p>
          </div>
          <Switch
            id="help-improve-atlarix"
            checked={analyticsOptedIn}
            onCheckedChange={(checked) => {
              updateSettings({
                telemetryConsent: checked ? "opted_in" : "opted_out",
              });
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-4 pt-4 border-t border-border mt-4">
          <div className="space-y-0.5">
            <label className="text-sm font-medium text-foreground">
              Appearance
            </label>
            <p className="text-xs text-muted-foreground">
              Choose light, dark, or follow your system setting.
            </p>
          </div>
          <Select
            value={theme}
            onValueChange={(v) => setTheme(v as "system" | "light" | "dark")}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* LANGUAGE — one setting, both halves. It selects the UI catalog and it
            is what `system_prompt.ts` reads (in MAIN, never from a renderer that
            could be stale) to tell the model which language to reply in. The
            picker shows endonyms because someone looking for their own language
            scans for the word they call it, not the English exonym. */}
        <div className="flex items-center justify-between gap-4 pt-4 border-t border-border mt-4">
          <div className="space-y-0.5">
            <label className="text-sm font-medium text-foreground">
              {t("language.label")}
            </label>
            <p className="text-xs text-muted-foreground">
              {t("language.description")}
            </p>
          </div>
          <Select
            value={settings?.appLanguage ?? "system"}
            onValueChange={(v) =>
              void updateSettings({
                appLanguage:
                  v === "system" ? undefined : (v as SupportedLocale),
              })
            }
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                {t("language.systemDefault")}
              </SelectItem>
              {SUPPORTED_LOCALES.map((l) => (
                <SelectItem key={l} value={l}>
                  {LOCALE_LABELS[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CliLauncherSettings />
      </div>
    </div>
  );
}

function CliLauncherSettings() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [cliPath, setCliPath] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await IpcClient.getInstance().checkCliInstalled();
      setInstalled(status.installed);
      setCliPath(status.path);
    } catch {
      setInstalled(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = async () => {
    setBusy(true);
    try {
      const result = await IpcClient.getInstance().installCli();
      if (result.success) {
        showSuccess(
          result.message ??
            "Installed — open a new terminal and try `atlarix .`",
        );
      } else if (result.cancelled) {
        /* user dismissed admin prompt */
      } else if (result.sudoCommand) {
        await navigator.clipboard.writeText(result.sudoCommand);
        showError(
          "Administrator access required — install command copied to clipboard",
        );
      } else {
        showError(result.error ?? "Could not install the atlarix command");
      }
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async () => {
    setBusy(true);
    try {
      const result = await IpcClient.getInstance().uninstallCli();
      if (result.success) {
        showSuccess(result.message ?? "Removed atlarix from PATH");
      } else if (result.cancelled) {
        /* user dismissed admin prompt */
      } else if (result.sudoCommand) {
        await navigator.clipboard.writeText(result.sudoCommand);
        showError(
          "Administrator access required — remove command copied to clipboard",
        );
      } else {
        showError(result.error ?? "Could not uninstall");
      }
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-4 border-t border-border mt-4 space-y-2">
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">Shell command</p>
        <p className="text-xs text-muted-foreground">
          Install <code className="text-[11px]">atlarix</code> in PATH, then run{" "}
          <code className="text-[11px]">atlarix .</code> in any project folder —
          opens that workspace if registered, or adds it automatically.
        </p>
        {cliPath ? (
          <p className="text-[11px] text-muted-foreground font-mono truncate">
            {cliPath}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {installed ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void handleUninstall()}
          >
            Uninstall from PATH
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void handleInstall()}
          >
            Install atlarix in PATH
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * DELETED: `WorkflowSettings`.
 *
 * It wrapped `WorkspaceTerminalPermissions`, `WorkspaceFilePermissions` and
 * `WorkspaceGrantedFolders` — all three of which read `selectedAppIdAtom` and
 * are per-project. They now live on `/workspace` (see
 * `pages/workspace-permissions.tsx`), where the route carries the scope instead
 * of the copy having to explain it ("...can be managed per workspace below when
 * a workspace is selected" was the sentence that gave it away).
 */

/**
 * `AISettings` was SPLIT, then split again.
 *
 * One card called "AI Settings" carried four unrelated things — voice input,
 * build verification, notification sounds, and the model provider grid — in
 * that order. The provider grid, which is the first thing a new user needs,
 * was last, in a card whose name did not mention models.
 *
 * The grid then left this file entirely: connecting a model is an integration,
 * so it is the index of /integrations now. What stays here are the two halves
 * that really are preferences — `VoiceSettings`, and `NotificationsSettings`,
 * which is where build verification belongs (it is a "tell me when"
 * preference, not a model one). Nothing was removed anywhere.
 */
export function VoiceSettings() {
  return (
    <div
      id="voice"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">Voice input</h2>
      <VoiceInputSettings />
    </div>
  );
}

export function NotificationsSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useTranslation("settings");
  return (
    <div
      id="notifications"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">
        Notifications &amp; automation
      </h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between max-w-md gap-4">
          <Label htmlFor="notif-sound-enabled" className="text-sm">
            Play a sound when Atlarix needs you (approval / questions)
          </Label>
          <Switch
            id="notif-sound-enabled"
            checked={settings?.notificationSound?.enabled !== false}
            onCheckedChange={(checked) =>
              updateSettings({
                notificationSound: {
                  ...settings?.notificationSound,
                  enabled: checked,
                },
              })
            }
          />
        </div>
        {settings?.notificationSound?.enabled !== false && (
          <div className="flex items-center justify-between max-w-md gap-4">
            <Label htmlFor="notif-sound-volume" className="text-sm">
              Volume
            </Label>
            <input
              id="notif-sound-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings?.notificationSound?.volume ?? 0.7}
              onChange={(e) =>
                updateSettings({
                  notificationSound: {
                    ...settings?.notificationSound,
                    volume: Number(e.target.value),
                  },
                })
              }
              className="w-40 accent-primary"
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground max-w-md">
          When the app is in the background, an OS notification is shown too
          (respects your system Do Not Disturb).
        </p>
      </div>

      <div className="mt-6 space-y-4 border-t border-border pt-6">
        <div className="flex items-center justify-between max-w-md gap-4">
          <Label htmlFor="build-verify-enabled" className="text-sm">
            Build verification after autonomous task complete
          </Label>
          <Switch
            id="build-verify-enabled"
            checked={settings?.buildVerification?.enabled !== false}
            onCheckedChange={(checked) =>
              updateSettings({
                buildVerification: {
                  ...settings?.buildVerification,
                  enabled: checked,
                },
              })
            }
          />
        </div>
      </div>

      <div className="mt-6 space-y-2 border-t border-border pt-6">
        <div className="flex items-center justify-between max-w-md gap-4">
          <Label htmlFor="peer-messages" className="text-sm">
            {t("peerMessages.label")}
          </Label>
          <Switch
            id="peer-messages"
            checked={settings?.peerMessages !== "refuse"}
            onCheckedChange={(checked) =>
              updateSettings({ peerMessages: checked ? "accept" : "refuse" })
            }
          />
        </div>
        <p className="text-xs text-muted-foreground max-w-md">
          {t("peerMessages.description")}
        </p>
      </div>

      <div className="mt-6 space-y-2 border-t border-border pt-6">
        <div className="flex items-center justify-between max-w-md gap-4">
          <Label htmlFor="session-recap" className="text-sm">
            {t("sessionRecap.label")}
          </Label>
          <Switch
            id="session-recap"
            checked={settings?.sessionRecap !== false}
            onCheckedChange={(checked) => updateSettings({ sessionRecap: checked })}
          />
        </div>
        <p className="text-xs text-muted-foreground max-w-md">
          {t("sessionRecap.description")}
        </p>
      </div>
    </div>
  );
}
