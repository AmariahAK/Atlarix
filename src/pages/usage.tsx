import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityCard } from "@/components/settings/ActivityCard";
import { EditStatsCard } from "@/components/settings/EditStatsCard";
import { SettingsWorkspaceNav } from "@/components/settings/SettingsWorkspaceNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IpcClient } from "@/ipc/ipc_client";
import { compactCount } from "@/lib/stats/activity-format";
import { shareCardSvg } from "@/lib/stats/share-card";
import {
  USAGE_TABS,
  creditSeries,
  shortDay,
  type CreditSeriesKey,
  type UsageTab,
} from "@/lib/stats/usage-format";
import { usdLabel } from "@/lib/stats/usage-labels";
import type {
  UsageCredits,
  UsageFilters,
  UsageOption,
  UsageReport,
} from "@/lib/stats/usage-types";
import { showError } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Usage: your activity on this computer, Atlarix credits, tokens per day by
 * model, MCP and skill calls, and which models Atlarix Auto answered with
 * (lib/stats/usage-report, lib/billing/usage-credits). The CLI's and ACP's
 * /usage and VS Code's Usage page show the same numbers.
 */

/** Series colours, then Other. */
const SERIES_BG = [
  "bg-(--chart-1)",
  "bg-(--chart-2)",
  "bg-(--chart-3)",
  "bg-(--chart-4)",
  "bg-(--chart-5)",
  "bg-muted-foreground/40",
] as const;
const seriesBg = (i: number) => SERIES_BG[Math.min(i, SERIES_BG.length - 1)];

/** A column a day, stacked by series and scaled to the busiest day. */
function DayColumns({
  days,
  title,
}: {
  days: Array<{ day: string; values: number[] }>;
  title: (d: { day: string; values: number[] }) => string;
}) {
  const max = Math.max(
    0,
    ...days.map((d) => d.values.reduce((a, b) => a + b, 0)),
  );
  return (
    <div className="flex h-40 items-end gap-[2px] border-b pb-px">
      {days.map((d) => {
        const total = d.values.reduce((a, b) => a + b, 0);
        return (
          <div
            key={d.day}
            title={title(d)}
            aria-label={title(d)}
            className="flex h-full min-w-[2px] flex-1 items-end"
          >
            {max > 0 && total > 0 ? (
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t-[2px]"
                style={{ height: `${Math.max(1.5, (total / max) * 100)}%` }}
              >
                {d.values.map((v, i) =>
                  v > 0 ? (
                    <span
                      key={i}
                      className={cn("min-h-px", seriesBg(i))}
                      style={{ flexGrow: v }}
                    />
                  ) : null,
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Legend({ labels }: { labels: string[] }) {
  return (
    <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {labels.map((l, i) => (
        <span
          key={`${l}-${i}`}
          className="inline-flex min-w-0 items-center gap-1.5"
        >
          <span className={cn("h-2 w-2 shrink-0 rounded-[2px]", seriesBg(i))} />
          <span className="truncate">{l}</span>
        </span>
      ))}
    </div>
  );
}

function Filter({
  label,
  value,
  options,
  all,
  onPick,
}: {
  label: string;
  value: string | null;
  options: UsageOption[];
  all: string;
  onPick: (v: string | undefined) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onPick(e.target.value || undefined)}
      className="bg-background max-w-[16rem] truncate rounded-md border px-2 py-1 text-sm"
    >
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Rows({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-center justify-between gap-3 text-sm"
        >
          <span className="truncate">{r.label}</span>
          <span className="text-muted-foreground whitespace-nowrap tabular-nums">
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => (
  <p className="text-muted-foreground text-sm">{children}</p>
);

/** The card as a PNG, through a canvas. */
async function cardPng(svg: string): Promise<{ blob: Blob; dataUrl: string }> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1200;
  canvas.height = img.naturalHeight || 630;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  const blob = await (await fetch(dataUrl)).blob();
  return { blob, dataUrl };
}

function ShareButtons({ report }: { report: UsageReport }) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);
  const svg = () => shareCardSvg(report.overview);
  return (
    <div className="flex shrink-0 gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            const { blob } = await cardPng(svg());
            await navigator.clipboard.write([
              new ClipboardItem({ "image/png": blob }),
            ]);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            showError("Couldn't copy the card.");
          }
        }}
      >
        {copied ? t("usage.copied") : t("usage.copyCard")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            await IpcClient.getInstance().saveUsageCard(
              (await cardPng(svg())).dataUrl,
            );
          } catch {
            showError("Couldn't save the card.");
          }
        }}
      >
        {t("usage.saveCard")}
      </Button>
    </div>
  );
}

function TokensTab({
  report: r,
  filters,
  setFilters,
}: {
  report: UsageReport;
  filters: UsageFilters;
  setFilters: (f: UsageFilters) => void;
}) {
  const { t } = useTranslation("settings");
  if (!r.tokens.since) return <Muted>{t("usage.tokensEmpty")}</Muted>;
  const set = (k: keyof UsageFilters) => (v: string | number | undefined) =>
    setFilters({ ...filters, [k]: v });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Filter
          label="Range"
          value={String(r.range)}
          options={[
            { key: "90", label: t("usage.range90") },
            { key: "365", label: t("usage.range365") },
          ]}
          all={t("usage.range30")}
          onPick={(v) => set("days")(v ? Number(v) : undefined)}
        />
        <Filter
          label="Model"
          value={r.filters.applied.model}
          options={r.filters.models}
          all={t("usage.allModels")}
          onPick={set("model")}
        />
        <Filter
          label="Surface"
          value={r.filters.applied.surface}
          options={r.filters.surfaces}
          all={t("usage.everywhere")}
          onPick={set("surface")}
        />
        <Filter
          label="Source"
          value={r.filters.applied.source}
          options={r.filters.sources}
          all={t("usage.allSources")}
          onPick={set("source")}
        />
      </div>
      <div className="text-xl font-semibold tabular-nums">
        {t("usage.tokensTotal", { tokens: compactCount(r.tokens.total) })}
      </div>
      <DayColumns
        days={r.tokens.byDay}
        title={(d) =>
          `${shortDay(d.day)}: ${compactCount(d.values.reduce((a, b) => a + b, 0))}`
        }
      />
      <Legend labels={r.tokens.series.map((s) => s.label)} />
      {r.byok ? (
        <div className="space-y-1 border-t pt-4">
          <div className="text-sm font-medium">
            {t("usage.byokTitle", { usd: usdLabel(r.byok.totalUsd) })}
          </div>
          <p className="text-muted-foreground text-xs">
            {t("usage.byokNote", {
              priced: r.byok.pricedTurns,
              day: r.byok.since,
            })}{" "}
            {r.byok.unpricedTurns > 0
              ? t("usage.byokUnpriced", { count: r.byok.unpricedTurns })
              : null}
          </p>
        </div>
      ) : null}
      <p className="text-muted-foreground border-t pt-2 text-xs">
        {t("usage.tokensSince", { day: r.tokens.since })}
      </p>
    </div>
  );
}

function ToolsTab({ report: r }: { report: UsageReport }) {
  const { t } = useTranslation("settings");
  if (!r.tools.byDay.some((d) => d.mcp + d.skill > 0))
    return <Muted>{t("usage.toolsEmpty", { days: r.range })}</Muted>;
  return (
    <div className="space-y-4">
      <DayColumns
        days={r.tools.byDay.map((d) => ({
          day: d.day,
          values: [d.mcp, d.skill],
        }))}
        title={(d) =>
          `${shortDay(d.day)}: ${d.values[0]} MCP, ${d.values[1]} skills`
        }
      />
      <Legend labels={["MCP", t("usage.skills")]} />
      <div className="grid gap-5 border-t pt-4 sm:grid-cols-2">
        {r.tools.mcp.length ? (
          <div className="space-y-1.5">
            <div className="text-sm font-medium">{t("usage.mcpServers")}</div>
            <Rows
              rows={r.tools.mcp.map((x) => ({
                label: x.name,
                value: `${x.runs} ${x.runs === 1 ? "call" : "calls"}`,
              }))}
            />
          </div>
        ) : null}
        {r.tools.skills.length ? (
          <div className="space-y-1.5">
            <div className="text-sm font-medium">{t("usage.skills")}</div>
            <Rows
              rows={r.tools.skills.map((x) => ({
                label: x.name,
                value: `${x.runs} ${x.runs === 1 ? "run" : "runs"}`,
              }))}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AutoTab({ report: r }: { report: UsageReport }) {
  const { t } = useTranslation("settings");
  if (r.autoPicks.steps === 0) return <Muted>{t("usage.autoEmpty")}</Muted>;
  const zenith = r.autoPicks.models.some((m) => m.tier === "zenith");
  return (
    <div className="space-y-4">
      <DayColumns
        days={r.autoPicks.byDay.map((d) => ({
          day: d.day,
          values: [d.paid, d.free],
        }))}
        title={(d) =>
          `${shortDay(d.day)}: ${d.values[0]} paid, ${d.values[1]} free`
        }
      />
      <Legend labels={[t("usage.paid"), t("usage.free")]} />
      <div className="space-y-1.5 border-t pt-4">
        <div className="text-sm font-medium">
          {t("usage.autoSteps", { count: r.autoPicks.steps })}
        </div>
        <Rows
          rows={r.autoPicks.models.map((m) => ({
            label: `${m.label} · ${zenith ? `${m.tier === "zenith" ? "Zenith" : "Auto"}, ` : ""}${m.billing === "paid" ? t("usage.paid") : t("usage.free")}`,
            value: `${m.share}%`,
          }))}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        {t("usage.autoNote", { day: r.autoPicks.since })}
      </p>
    </div>
  );
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function CreditsTab({
  credits: c,
  loading,
}: {
  credits: UsageCredits | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation("settings");
  if (loading || !c) return <Muted>{t("usage.loading")}</Muted>;
  if (c.state === "signed_out")
    return <Muted>{t("usage.creditsSignedOut")}</Muted>;
  if (c.state === "unavailable")
    return <Muted>{t("usage.creditsUnavailable")}</Muted>;
  const recent = c.days.slice(-30);
  const spent = c.days.reduce(
    (n, d) =>
      n +
      d.autoPaidCents +
      d.coreCents +
      d.toolCents +
      d.otherCents +
      d.unsplitCents,
    0,
  );
  const { series, byDay } = creditSeries(recent);
  const seriesName: Record<CreditSeriesKey, string> = {
    auto: t("usage.seriesAuto"),
    core: t("usage.seriesCore"),
    other: t("usage.seriesOther"),
    unsplit: t("usage.seriesUnsplit"),
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <div className="text-xl font-semibold tabular-nums">
            {dollars(c.balanceCents)}
          </div>
          <div className="text-muted-foreground text-xs">
            {t("usage.balance")}
          </div>
        </div>
        {c.plan === "pro" && c.grantedTotalCents > 0 ? (
          <div>
            <div className="text-xl font-semibold tabular-nums">
              {dollars(c.grantedTotalCents - c.grantedCents)} /{" "}
              {dollars(c.grantedTotalCents)}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("usage.proUsed")}
            </div>
          </div>
        ) : null}
        {c.plan === "pro" && c.renewsAt ? (
          <div>
            <div className="text-xl font-semibold">
              {new Date(c.renewsAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("usage.resets")}
            </div>
          </div>
        ) : null}
      </div>
      {spent === 0 ? (
        <Muted>{t("usage.creditsEmpty")}</Muted>
      ) : (
        <div className="space-y-3 border-t pt-4">
          <div className="text-sm font-medium">{t("usage.spent30")}</div>
          <DayColumns
            days={byDay}
            title={(d) =>
              `${shortDay(d.day)}: ${dollars(d.values.reduce((a, b) => a + b, 0))}`
            }
          />
          <Legend labels={series.map((x) => seriesName[x.key])} />
        </div>
      )}
    </div>
  );
}

export function UsagePage() {
  const { t } = useTranslation("settings");
  const [tab, setTab] = useState<UsageTab>("overview");
  const [filters, setFilters] = useState<UsageFilters>({});
  const report = useQuery({
    queryKey: ["usage", "report", filters],
    queryFn: () => IpcClient.getInstance().getUsageReport(filters),
    placeholderData: (prev) => prev,
  });
  const credits = useQuery({
    queryKey: ["usage", "credits"],
    queryFn: () => IpcClient.getInstance().getUsageCredits(),
    enabled: tab === "credits",
  });
  const r = report.data;

  return (
    <div className="min-h-full bg-background p-8 pb-12">
      <div className="mx-auto max-w-4xl space-y-8">
        <SettingsWorkspaceNav />
        <h1 className="text-3xl font-bold">{t("usage.title")}</h1>
        <Tabs value={tab} onValueChange={(v) => setTab(v as UsageTab)}>
          <TabsList>
            {USAGE_TABS.map((x) => (
              <TabsTrigger key={x.key} value={x.key}>
                {t(`usage.tabs.${x.key}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview" className="space-y-8">
            {r ? (
              <ActivityCard
                data={r.overview}
                action={<ShareButtons report={r} />}
              />
            ) : null}
            <EditStatsCard />
          </TabsContent>
          {(["credits", "tokens", "tools", "auto"] as const).map((key) => (
            <TabsContent key={key} value={key}>
              <Card>
                <CardContent className="pt-6">
                  {key === "credits" ? (
                    <CreditsTab
                      credits={credits.data}
                      loading={credits.isLoading}
                    />
                  ) : !r ? (
                    <Muted>
                      {report.error ? t("usage.error") : t("usage.loading")}
                    </Muted>
                  ) : key === "tokens" ? (
                    <TokensTab
                      report={r}
                      filters={filters}
                      setFilters={setFilters}
                    />
                  ) : key === "tools" ? (
                    <ToolsTab report={r} />
                  ) : (
                    <AutoTab report={r} />
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>
        {tab === "overview" && !r ? (
          <Muted>{report.error ? t("usage.error") : t("usage.loading")}</Muted>
        ) : null}
      </div>
    </div>
  );
}
