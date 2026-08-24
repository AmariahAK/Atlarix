import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useEditStats } from "@/hooks/useEditStats";
import { editStatsModelLabel } from "@/lib/stats/edit-stats-label";
import { EditStatsCalendar } from "@/components/settings/EditStatsCalendar";
import { shouldShowCalendar } from "@/lib/stats/edit-stats-calendar";
import type { EditStatsModelRow } from "@/ipc/ipc_types";

/** Workspaces shown before "Show all" — enough to be useful, short enough to scan. */
const VISIBLE_WORKSPACES = 5;

function LineDelta({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-sm whitespace-nowrap">
      <span className="text-emerald-500">+{added.toLocaleString()}</span>{" "}
      <span className="text-red-400">−{removed.toLocaleString()}</span>
    </span>
  );
}

export function EditStatsCard({ className = "" }: { className?: string }) {
  const { data, isLoading, error } = useEditStats();
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);

  const workspaces = data?.byWorkspace ?? [];
  const visible = showAllWorkspaces
    ? workspaces
    : workspaces.slice(0, VISIBLE_WORKSPACES);
  const favouriteModel: EditStatsModelRow | undefined = data?.byModel[0];
  const showCalendar = shouldShowCalendar(data?.byDay ?? []);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Code written</CardTitle>
        <CardDescription>
          Lines the agent has added and removed in your projects
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : error ? (
          <p className="text-muted-foreground text-sm">
            Couldn't read your edit history.
          </p>
        ) : workspaces.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing yet. Once you accept an edit in a project, it'll show up here.
          </p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <div className="text-2xl font-bold">
                  <LineDelta
                    added={data!.totals.linesAdded}
                    removed={data!.totals.linesRemoved}
                  />
                </div>
                <p className="text-muted-foreground text-sm mt-1">
                  across {workspaces.length}{" "}
                  {workspaces.length === 1 ? "project" : "projects"} ·{" "}
                  {data!.totals.edits.toLocaleString()}{" "}
                  {data!.totals.edits === 1 ? "edit" : "edits"}
                </p>
              </div>
              {favouriteModel ? (
                <div className="text-right">
                  <p className="text-muted-foreground text-xs">Most used</p>
                  <p className="font-medium">
                    {editStatsModelLabel(favouriteModel)}
                  </p>
                </div>
              ) : null}
            </div>

            {/* The calendar appears only once there is enough history to be worth
                drawing. There is no backfill, so on day one a year-wide grid would be
                ~360 blank squares and one green one — which reads as broken rather
                than as new. */}
            {showCalendar ? (
              <div className="pt-4 border-t">
                <EditStatsCalendar byDay={data!.byDay} />
              </div>
            ) : null}

            <div className="pt-4 border-t space-y-2">
              {visible.map((row) => (
                <div
                  key={row.workspaceId}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="truncate" title={row.path}>
                    {row.name}
                  </span>
                  <LineDelta
                    added={row.linesAdded}
                    removed={row.linesRemoved}
                  />
                </div>
              ))}
              {workspaces.length > VISIBLE_WORKSPACES ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-0"
                  onClick={() => setShowAllWorkspaces((v) => !v)}
                >
                  {showAllWorkspaces
                    ? "Show fewer"
                    : `Show all ${workspaces.length}`}
                </Button>
              ) : null}
            </div>

            {data!.byModel.length > 1 ? (
              <div className="pt-4 border-t space-y-2">
                {data!.byModel.map((row) => (
                  <div
                    key={`${row.provider}:${row.modelId}`}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="truncate">{editStatsModelLabel(row)}</span>
                    <LineDelta
                      added={row.linesAdded}
                      removed={row.linesRemoved}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}

        {/*
          Say what the number is, so it can be trusted. Commands the agent runs
          (a codegen script, a formatter, `sed -i`) change files without passing
          the write gate these counts come from, so they are genuinely not in
          here — and a count that quietly omitted them would be worse than a
          smaller one that says so.
        */}
        <p className="text-muted-foreground text-xs pt-2 border-t">
          Counts edits the agent made through its file tools. Changes made by
          commands it ran aren't included. This is stored only on this computer.
        </p>
      </CardContent>
    </Card>
  );
}
