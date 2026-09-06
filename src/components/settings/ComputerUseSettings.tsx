/**
 * Desktop computer use (Settings → Computer use).
 *
 * WHY THERE IS A PANEL AT ALL, given there is deliberately no per-app prompt.
 * The decision was "no prompt", not "no switch". Two things need a home:
 *
 *  1. **The macOS grants.** Nothing works until Accessibility and Screen Recording
 *     are granted to Atlarix, macOS caches the screen-capture decision PER PROCESS
 *     so a grant needs a relaunch, and there is no other surface that could say so.
 *  2. **An off switch.** This is the broadest capability in the app — every
 *     application on the machine, no per-app consent — so somewhere to see its
 *     state and turn it off is the minimum. `.atlarix/permissions.json` remains the
 *     committable, per-project kill switch.
 *
 * NOTHING RUNS ON MOUNT. Reading permission state is non-prompting
 * (`isTrustedAccessibilityClient(false)`), and the Grant buttons are the consent —
 * the same standard `DiagnosticsPanel` already sets, where the button is what
 * starts anything.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { showError } from "@/lib/toast";

type GrantState = "granted" | "denied" | "not-determined" | "unsupported";

interface PermissionReport {
  platform: string;
  accessibility: GrantState;
  screenRecording: GrantState;
  needsRelaunch: boolean;
}

function StateIcon({ state }: { state: GrantState }) {
  if (state === "granted") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (state === "unsupported") return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
  if (state === "not-determined") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  return <XCircle className="h-4 w-4 text-red-500" />;
}

function GrantRow({
  title,
  what,
  state,
  onGrant,
  canPrompt,
  busy,
}: {
  title: string;
  what: string;
  state: GrantState;
  onGrant: () => void;
  /** True when macOS still lets the app raise the dialog itself. */
  canPrompt?: boolean;
  busy: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border last:border-0">
      <div className="flex items-start gap-2 min-w-0">
        <span className="mt-0.5 shrink-0">
          <StateIcon state={state} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <p className="text-xs text-muted-foreground">{what}</p>
        </div>
      </div>
      {state === "granted" || state === "unsupported" ? (
        <span className="text-xs text-muted-foreground shrink-0 mt-1">
          {state === "granted" ? "Granted" : "Not applicable"}
        </span>
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={onGrant} className="shrink-0">
          {/*
            THE LABEL HAS TO MATCH WHAT THE CLICK CAN DO. Accessibility has a real
            prompting API. Screen Recording does not — Apple moved that consent to
            ScreenCaptureKit and no Electron call raises the dialog, so all this
            button can do is open the pane. Labelling both "Grant" is why fourteen
            clicks across two days read as "I granted it and it still says no".
          */}
          {busy ? "Opening…" : canPrompt ? "Grant" : "Open Settings"}
        </Button>
      )}
    </div>
  );
}

export function ComputerUseSettings() {
  const { settings, updateSettings } = useSettings();
  const [perms, setPerms] = useState<PermissionReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const enabled = settings?.computerUse !== false;
  const overlay = settings?.computerUseConfig?.overlay !== false;
  const reducedMotion = settings?.computerUseConfig?.reducedMotion ?? "auto";

  const refresh = useCallback(async () => {
    try {
      setPerms(await IpcClient.getInstance().getComputerUsePermissions());
    } catch {
      // A build without the feature, or a platform where it does not apply.
      setPerms(null);
    }
  }, []);

  // Reading is non-prompting, so this is safe on mount — unlike the Grant
  // buttons, which are the consent.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grant = async (which: "accessibility" | "screenRecording") => {
    setBusy(which);
    try {
      setPerms(await IpcClient.getInstance().requestComputerUsePermission(which));
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm font-medium">Let the agent use other applications</Label>
          <p className="text-xs text-muted-foreground mt-1">
            Reads and clicks in any app on this machine — Slack, Excel, a browser — in the
            background, without moving your cursor or stealing focus. It never targets Atlarix
            itself, and never types into a terminal or a password field. Add{" "}
            <code>{'{"deny": ["computer*"]}'}</code> to a project&apos;s{" "}
            <code>.atlarix/permissions.json</code> to switch it off for that project only,
            or a narrower rule like <code>{'computer_call(kill_app)'}</code> for one action.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => void updateSettings({ computerUse: v })}
          className="shrink-0 mt-1"
        />
      </div>

      {enabled ? (
        <>
          <div>
            <Label className="text-sm font-medium">Permissions</Label>
            <div className="mt-2">
              <GrantRow
                title="Accessibility"
                what="Read what is on screen and click it. Without this, nothing works."
                state={perms?.accessibility ?? "not-determined"}
                busy={busy === "accessibility"}
                onGrant={() => void grant("accessibility")}
                canPrompt
              />
              <GrantRow
                title="Screen Recording"
                what="Needed only to read apps that draw their own surface (OCR) and to outline elements. Reading and clicking work without it. macOS will not let Atlarix ask for this one — switch it on in the pane, then restart Atlarix."
                state={perms?.screenRecording ?? "not-determined"}
                busy={busy === "screenRecording"}
                onGrant={() => void grant("screenRecording")}
              />
            </div>
            {perms?.platform && perms.platform !== "darwin" ? (
              // Say this rather than showing two green ticks: there is no OS gate
              // on Windows or Linux, which is a fact about the platform, not a
              // permission we hold.
              <p className="text-xs text-muted-foreground mt-2">
                {perms.platform === "win32" ? "Windows" : "Linux"} has no system permission for
                this — installing Atlarix is the consent. Elevated (administrator) windows can
                never be driven.
              </p>
            ) : null}
            {perms?.needsRelaunch ? (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                <p className="text-xs text-foreground">
                  A permission changed. macOS only applies it to a fresh process, so Atlarix has
                  to restart before desktop control will work.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void IpcClient.getInstance().relaunchForComputerUse()}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  Restart
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Label className="text-sm font-medium">Show what it is doing</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Draws a cursor where the agent acts and outlines the element it is about to
                touch. Your own pointer never moves.
              </p>
            </div>
            <Switch
              checked={overlay}
              onCheckedChange={(v) =>
                void updateSettings({
                  // `writeSettings` shallow-merges, so the existing object must be
                  // spread or the sibling key is dropped.
                  computerUseConfig: { ...settings?.computerUseConfig, overlay: v },
                })
              }
              className="shrink-0 mt-1"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label className="text-sm font-medium">Motion</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Whether the agent&apos;s cursor animates between targets.
              </p>
            </div>
            <Select
              value={reducedMotion}
              onValueChange={(v) =>
                void updateSettings({
                  computerUseConfig: {
                    ...settings?.computerUseConfig,
                    reducedMotion: v as "auto" | "on" | "off",
                  },
                })
              }
            >
              <SelectTrigger className="w-40 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Follow the system</SelectItem>
                <SelectItem value="on">Reduce motion</SelectItem>
                <SelectItem value="off">Allow motion</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      ) : null}
    </div>
  );
}
