import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IpcClient } from "@/ipc/ipc_client";
import { editStatsModelLabel } from "@/lib/stats/edit-stats-label";
import {
  activityModeLabel,
  activitySurfaceLabel,
  compactCount,
  durationLabel,
} from "@/lib/stats/activity-format";
import { cn } from "@/lib/utils";

/**
 * Your activity on this computer: the agent's turns across the app, CLI and
 * editors (lib/stats/usage-stats). The same picture the CLI's and ACP's /stats
 * and VS Code's Account panel draw, laid out for a page.
 */

/** The same colour ramp as the Code written calendar. */
const LEVEL_BG = [
  "bg-(--calendar-0)",
  "bg-(--calendar-1)",
  "bg-(--calendar-2)",
  "bg-(--calendar-3)",
  "bg-(--calendar-4)",
] as const;
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function Ranked({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string }>;
}) {
  if (!rows.length) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{title}</div>
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-center justify-between gap-3 text-sm"
        >
          <span className="truncate">{r.label}</span>
          <span className="text-muted-foreground tabular-nums whitespace-nowrap">
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ActivityCard({ className = "" }: { className?: string }) {
  const { t } = useTranslation("settings");
  const { data, isLoading, error } = useQuery({
    queryKey: ["usage", "activity"],
    queryFn: () => IpcClient.getInstance().getActivityStats(),
  });

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{t("activity.title")}</CardTitle>
        <CardDescription>{t("activity.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-muted-foreground text-sm">
            {t("activity.loading")}
          </p>
        ) : error || !data ? (
          <p className="text-muted-foreground text-sm">{t("activity.error")}</p>
        ) : !data.since ? (
          <p className="text-muted-foreground text-sm">{t("activity.empty")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              <Tile
                value={compactCount(data.lifetimeTokens)}
                label="Lifetime tokens"
              />
              <Tile
                value={data.peakDay ? compactCount(data.peakDay.tokens) : "—"}
                label="Busiest day"
              />
              <Tile
                value={
                  data.longestChat
                    ? durationLabel(data.longestChat.minutes)
                    : "—"
                }
                label="Longest chat"
              />
              <Tile
                value={`${data.currentStreak} ${data.currentStreak === 1 ? "day" : "days"}`}
                label="Current streak"
              />
              <Tile
                value={`${data.longestStreak} ${data.longestStreak === 1 ? "day" : "days"}`}
                label="Longest streak"
              />
            </div>

            <div className="pt-4 border-t">
              <div className="text-sm font-medium mb-2">
                {t("activity.calendar")}
              </div>
              <div className="overflow-x-auto pb-1">
                <div className="inline-flex gap-1">
                  <div
                    className="grid grid-rows-7 gap-[3px] pr-1 pt-[18px]"
                    aria-hidden="true"
                  >
                    {WEEKDAYS.map((d) => (
                      <div
                        key={d}
                        className="text-muted-foreground h-[11px] text-[9px] leading-[11px]"
                      >
                        {d}
                      </div>
                    ))}
                  </div>
                  <div>
                    <div className="flex gap-[3px]" aria-hidden="true">
                      {data.monthLabels.map((m, i) => (
                        <div
                          key={i}
                          className="text-muted-foreground w-[11px] text-[9px] leading-[18px] whitespace-nowrap"
                        >
                          {m}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-[3px]">
                      {data.weeks.map((week, w) => (
                        <div key={w} className="grid grid-rows-7 gap-[3px]">
                          {week.map((d) => (
                            <div
                              key={d.day}
                              title={
                                d.inRange
                                  ? `${d.day}: ${d.turns} ${d.turns === 1 ? "turn" : "turns"}`
                                  : undefined
                              }
                              aria-label={
                                d.inRange
                                  ? `${d.day}: ${d.turns} turns`
                                  : undefined
                              }
                              className={cn(
                                "h-[11px] w-[11px] rounded-[2px]",
                                d.inRange
                                  ? LEVEL_BG[d.level]
                                  : "bg-transparent",
                              )}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-muted-foreground mt-2 flex items-center gap-1 text-[10px]">
                {t("activity.less")}
                {LEVEL_BG.map((bg) => (
                  <span
                    key={bg}
                    className={cn("h-[9px] w-[9px] rounded-[2px]", bg)}
                  />
                ))}
                {t("activity.more")}
              </div>
            </div>

            <div className="pt-4 border-t grid gap-5 sm:grid-cols-2">
              <Ranked
                title="Favourite models"
                rows={data.models.map((m) => ({
                  label: editStatsModelLabel(m),
                  value: `${m.share}%`,
                }))}
              />
              <Ranked
                title="Modes"
                rows={[
                  ...data.modes.map((m) => ({
                    label: activityModeLabel(m.mode),
                    value: `${m.share}%`,
                  })),
                  ...(data.deepShare > 0
                    ? [{ label: "Deep thinking", value: `${data.deepShare}%` }]
                    : []),
                ]}
              />
              <Ranked
                title="Most used skills"
                rows={data.skills.map((s) => ({
                  label: s.name,
                  value: `${s.runs} ${s.runs === 1 ? "run" : "runs"}`,
                }))}
              />
              <Ranked
                title="Most used MCP servers"
                rows={data.mcp.map((s) => ({
                  label: s.name,
                  value: `${s.runs} ${s.runs === 1 ? "call" : "calls"}`,
                }))}
              />
              <Ranked
                title="Where you work"
                rows={data.surfaces.map((s) => ({
                  label: activitySurfaceLabel(s.surface),
                  value: `${s.turns} ${s.turns === 1 ? "turn" : "turns"}`,
                }))}
              />
              <Ranked
                title="Totals"
                rows={[
                  { label: "Chats", value: data.totalChats.toLocaleString() },
                  { label: "Turns", value: data.totalTurns.toLocaleString() },
                  ...(data.linesWritten > 0
                    ? [
                        {
                          label: "Lines written",
                          value: data.linesWritten.toLocaleString(),
                        },
                      ]
                    : []),
                ]}
              />
            </div>

            <p className="text-muted-foreground text-xs pt-2 border-t">
              {data.recordedSince
                ? t("activity.footnoteSince", { day: data.recordedSince })
                : t("activity.footnoteNext")}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
