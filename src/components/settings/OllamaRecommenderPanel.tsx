/**
 * Hardware-aware Ollama model suggestions (public catalog + local tier + agent-tooling allowlist).
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { showError, showSuccess } from "@/lib/toast";
import { Cpu, Download, HelpCircle, Loader2 } from "lucide-react";
import type { UserSettings } from "@/lib/schemas";

type HardwareProfile = {
  totalMemBytes: number;
  cpuCount: number;
  platform: string;
  arch: string;
  cpuModel: string;
  gpuVramMb?: number;
  tier: string;
};

type OllamaRec = {
  name: string;
  supportsAgents: boolean;
  sizeClass: string;
  why: string;
};

type RecommendationsPayload = {
  profile: HardwareProfile;
  recommendations: OllamaRec[];
};

interface OllamaRecommenderPanelProps {
  settings: UserSettings | null | undefined;
  onFavoritesPatched: (patch: { favoriteModelIds: string[] }) => Promise<void>;
}

export function OllamaRecommenderPanel({
  settings,
  onFavoritesPatched,
}: OllamaRecommenderPanelProps) {
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RecommendationsPayload | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ipc = window.electron?.ipcRenderer;
      if (!ipc?.invoke) {
        setError("IPC unavailable");
        return;
      }
      const res = (await ipc.invoke("ollama:get-recommendations")) as RecommendationsPayload;
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const memGb = data?.profile
    ? (data.profile.totalMemBytes / 1024 ** 3).toFixed(1)
    : "—";
  const vram =
    data?.profile?.gpuVramMb != null ? `${Math.round(data.profile.gpuVramMb)} MB VRAM` : "GPU: not detected (CPU-only tier)";

  return (
    <div className="mt-8 rounded-lg border border-border bg-muted/20 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium flex items-center gap-2">
            <Cpu className="h-4 w-4" aria-hidden />
            Suggested models for this machine
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Picks use your RAM/VRAM tier, the public Ollama library, and families that work well with Atlarix agents
            (tool calling).
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading hardware & catalog…
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : data ? (
        <>
          <div className="text-xs text-muted-foreground space-y-1 rounded-md bg-background/60 p-3 border border-border/60">
            <p>
              <span className="font-medium text-foreground">Tier:</span> {data.profile.tier} ·{" "}
              <span className="font-medium text-foreground">RAM:</span> {memGb} GB ·{" "}
              <span className="font-medium text-foreground">CPUs:</span> {data.profile.cpuCount} · {vram}
            </p>
            <p className="truncate" title={data.profile.cpuModel}>
              {data.profile.platform} / {data.profile.arch} — {data.profile.cpuModel}
            </p>
          </div>

          {data.recommendations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No catalog matches for this tier. Try a larger model after pulling manually, or lower tier filters in a
              future release.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.recommendations.map((rec) => (
                <li
                  key={rec.name}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 bg-background"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm truncate">{rec.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Supports Atlarix agents · {rec.sizeClass}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Why this model?">
                            <HelpCircle className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-sm text-xs">
                          {rec.why}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={pulling !== null}
                      onClick={async () => {
                        setPulling(rec.name);
                        try {
                          const ipc = window.electron?.ipcRenderer;
                          if (!ipc?.invoke) {
                            showError("IPC unavailable");
                            return;
                          }
                          const res = (await ipc.invoke(
                            "ollama:pull-model",
                            rec.name,
                          )) as { success: boolean; error?: string };
                          if (!res.success) {
                            showError(res.error ?? "Pull failed");
                          } else {
                            showSuccess(`Pulled ${rec.name}`);
                          }
                        } catch (e) {
                          showError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setPulling(null);
                        }
                      }}
                    >
                      {pulling === rec.name ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-1" />
                      )}
                      Pull
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={async () => {
                        const cur =
                          (settings?.providerSettings?.ollama as { favoriteModelIds?: string[] } | undefined)
                            ?.favoriteModelIds ?? [];
                        const next = [...cur];
                        if (next.length === 0) next.push(rec.name);
                        else next[0] = rec.name;
                        await onFavoritesPatched({ favoriteModelIds: next.slice(0, 3) });
                        showSuccess(`Set ${rec.name} as Fast favorite`);
                      }}
                    >
                      Use as Fast
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
