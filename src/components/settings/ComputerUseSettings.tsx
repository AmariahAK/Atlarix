/**
 * Settings → Computer use: which models may see the screen and use the mouse
 * and keyboard (off for all until switched on), and, on macOS, the two system
 * grants that needs. A model that can't have it says why instead of vanishing.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IpcClient } from "@/ipc/ipc_client";
import type { ComputerUsePermissions } from "@/ipc/ipc_types";
import { useSettings } from "@/hooks/useSettings";
import { useConfiguredProviders } from "@/hooks/useConfiguredProviders";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { computerUseKey, ineligibleReason } from "@/lib/computer/eligibility";

const GRANTS = ["screen", "accessibility"] as const;

function Permissions() {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<ComputerUsePermissions | null>(null);
  const [asked, setAsked] = useState(false);
  const read = useCallback(async (request?: "screen" | "accessibility") => {
    setState(await IpcClient.getInstance().computerUsePermissions(request));
  }, []);
  useEffect(() => {
    void read();
  }, [read]);

  if (!state || "error" in state || state.screen === "unsupported") return null;
  const missing = GRANTS.filter((g) => state[g] !== "granted");
  return (
    <div className="mb-6 space-y-3 max-w-md">
      {GRANTS.map((g) => (
        <div key={g} className="flex items-center justify-between gap-4">
          <span className="text-sm">{t(`computerUse.${g}`)}</span>
          {state[g] === "granted" ? (
            <span className="text-sm text-muted-foreground">{t("computerUse.allowed")}</span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAsked(true);
                void read(g);
              }}
            >
              {t("computerUse.allow")}
            </Button>
          )}
        </div>
      ))}
      {asked && missing.length > 0 && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground">{t("computerUse.restartHint")}</span>
          <Button size="sm" variant="outline" onClick={() => void IpcClient.getInstance().relaunchForComputerUse()}>
            {t("computerUse.restart")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function ComputerUseSettings() {
  const { t } = useTranslation("settings");
  const { settings, updateSettings } = useSettings();
  const { data: configured } = useConfiguredProviders();
  const { data: providers } = useLanguageModelProviders();
  const { data: modelsByProvider } = useLanguageModelsByProviders();
  const on = new Set(settings?.computerUseModels ?? []);

  const toggle = (key: string, next: boolean) => {
    const rest = (settings?.computerUseModels ?? []).filter((k) => k !== key);
    updateSettings({ computerUseModels: next ? [...rest, key] : rest });
  };

  return (
    <div id="computer-use" className="bg-card rounded-xl shadow-sm p-6 border border-border">
      <h2 className="text-lg font-medium text-foreground mb-1">{t("computerUse.label")}</h2>
      <p className="text-sm text-muted-foreground mb-6 max-w-md">{t("computerUse.description")}</p>
      <Permissions />
      <div className="space-y-6">
        {(configured ?? []).map((providerId) => {
          const models = modelsByProvider?.[providerId] ?? [];
          if (models.length === 0) return null;
          const name = providers?.find((p) => p.id === providerId)?.name ?? providerId;
          return (
            <div key={providerId} className="space-y-2 max-w-md">
              <h3 className="text-sm font-medium">{name}</h3>
              {models.map((m) => {
                const key = computerUseKey({ provider: providerId, name: m.apiName });
                const id = `computer-use-${key}`;
                const why = m.computerUse && m.computerUse !== "eligible" ? m.computerUse : null;
                return (
                  <div key={key} className="flex items-start justify-between gap-4">
                    <Label htmlFor={id} className="text-sm font-normal">
                      {m.displayName}
                      {why && <span className="block text-xs text-muted-foreground">{ineligibleReason(why)}</span>}
                    </Label>
                    <Switch
                      id={id}
                      disabled={why != null}
                      checked={why == null && on.has(key)}
                      onCheckedChange={(next) => toggle(key, next)}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
