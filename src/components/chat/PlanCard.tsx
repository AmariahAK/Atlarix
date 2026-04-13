/**
 * Plan card: task groups, status, agent icons, "Switch to Build" (v3.6).
 */

import React from "react";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  Wrench,
  Layout,
  Search,
  Shield,
  Bot,
  Bug,
} from "lucide-react";
import type { PlanCardData, PlanTaskStatus, PlanAgentId } from "@/lib/plan-cards/plan-card-renderer";
import { useSettings } from "@/hooks/useSettings";

const AGENT_ICONS: Record<PlanAgentId, React.ReactNode> = {
  main: <Bot size={14} className="text-muted-foreground" />,
  architect: <Layout size={14} className="text-muted-foreground" />,
  builder: <Wrench size={14} className="text-muted-foreground" />,
  reviewer: <Shield size={14} className="text-muted-foreground" />,
  researcher: <Search size={14} className="text-muted-foreground" />,
  debugger: <Bug size={14} className="text-muted-foreground" />,
};

const STATUS_ICONS: Record<PlanTaskStatus, React.ReactNode> = {
  pending: <Circle size={14} className="text-muted-foreground/60" />,
  in_progress: <Loader2 size={14} className="text-primary animate-spin" />,
  done: <CheckCircle2 size={14} className="text-green-600" />,
  failed: <XCircle size={14} className="text-destructive" />,
};

interface PlanCardProps {
  data: PlanCardData;
  onSwitchToBuild?: (autoMessage: string, planData: PlanCardData) => void;
  /** Inside PlanSection — skip duplicate outer "Plan" chrome */
  embedded?: boolean;
}

export function PlanCard({ data, onSwitchToBuild, embedded = false }: PlanCardProps) {
  const { updateSettings } = useSettings();

  const handleSwitchToBuild = () => {
    void updateSettings({
      selectedChatMode: "build",
      intentMode: "build",
      workModePreference: "build",
    });
    onSwitchToBuild?.(
      "Continue in Build mode: execute the plan shown above step by step.",
      data,
    );
  };

  const switchBtn = !data.completed ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 text-xs"
      onClick={handleSwitchToBuild}
    >
      Switch to Build
    </Button>
  ) : null;

  const taskList = (
    <div className={embedded ? "space-y-3" : "p-3 space-y-3"}>
      {data.taskGroups.map((group) => (
        <div key={group.id} className="space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            {group.agentId && AGENT_ICONS[group.agentId]}
            {group.title}
          </div>
          <ul className="space-y-1">
            {group.tasks.map((task) => (
              <li
                key={task.id}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <span className="shrink-0">{STATUS_ICONS[task.status]}</span>
                {task.agentId && (
                  <span className="shrink-0">{AGENT_ICONS[task.agentId]}</span>
                )}
                <span>{task.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );

  const completedFooter =
    data.completed ? (
      <div
        className={
          embedded
            ? "pt-2 flex items-center gap-2 text-sm text-green-600"
            : "px-3 py-2 border-t border-border flex items-center gap-2 text-sm text-green-600"
        }
      >
        <CheckCircle2 size={16} />
        Plan completed
      </div>
    ) : null;

  if (embedded) {
    return (
      <div className="space-y-2">
        {taskList}
        {completedFooter}
        {switchBtn && <div className="flex justify-end pt-1">{switchBtn}</div>}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Plan</span>
        {switchBtn}
      </div>
      {taskList}
      {completedFooter}
    </div>
  );
}
