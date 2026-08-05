/**
 * Create/edit dialog for an automation definition: name, trigger (schedule /
 * GitHub poll / MCP poll), prompt, and run mode. MCP triggers surface the
 * pre-consent notice — saving grants consent="always" for that server+tool.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { IpcClient } from "@/ipc/ipc_client";
import type { AutomationListItem } from "@/atoms/automationAtoms";
import type { AutomationTrigger } from "@/lib/automations/types";

const SCHEDULE_PRESETS: Array<{ key: string; label: string; cron: string }> = [
  { key: "hourly", label: "Hourly", cron: "0 * * * *" },
  { key: "daily", label: "Daily (9am)", cron: "0 9 * * *" },
  { key: "weekly", label: "Weekly (Mon 9am)", cron: "0 9 * * 1" },
  { key: "weekday-mornings", label: "Weekday mornings", cron: "0 9 * * 1-5" },
];

const GITHUB_EVENTS: Array<{ key: "new-pr" | "review-requested" | "ci-failed"; label: string }> = [
  { key: "new-pr", label: "New pull request" },
  { key: "review-requested", label: "Review requested from me" },
  { key: "ci-failed", label: "CI run failed" },
];

function cnRunMode(disabled: boolean, selected: boolean): string {
  return [
    "flex items-start gap-2 rounded-md border p-2.5 cursor-pointer",
    selected ? "border-primary/60 bg-primary/5" : "border-border",
    disabled ? "opacity-50 cursor-not-allowed" : "",
  ].join(" ");
}

interface McpServerOption {
  id: number;
  name: string;
}

export function AutomationForm({
  workspaceId,
  existing,
  mcpServers,
  defaultRepo,
  open,
  onClose,
  onSaved,
}: {
  workspaceId: number;
  existing: AutomationListItem | null;
  mcpServers: McpServerOption[];
  defaultRepo: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existingTrigger = existing?.trigger as AutomationTrigger | undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<AutomationTrigger["kind"]>(existingTrigger?.kind ?? "schedule");
  const [cron, setCron] = useState(
    existingTrigger?.kind === "schedule" ? existingTrigger.cron : SCHEDULE_PRESETS[1].cron,
  );
  const [repo, setRepo] = useState(
    existingTrigger?.kind === "github" ? existingTrigger.repo : (defaultRepo ?? ""),
  );
  const [events, setEvents] = useState<Array<"new-pr" | "review-requested" | "ci-failed">>(
    existingTrigger?.kind === "github" ? existingTrigger.events : ["new-pr"],
  );
  const [interval, setIntervalMin] = useState(
    existingTrigger?.kind === "github" || existingTrigger?.kind === "mcp"
      ? existingTrigger.intervalMinutes
      : 15,
  );
  const [mcpServerId, setMcpServerId] = useState<number | null>(
    existingTrigger?.kind === "mcp" ? existingTrigger.serverId : (mcpServers[0]?.id ?? null),
  );
  const [mcpTool, setMcpTool] = useState(existingTrigger?.kind === "mcp" ? existingTrigger.tool : "");
  const [mcpArgs, setMcpArgs] = useState(
    existingTrigger?.kind === "mcp" && existingTrigger.args != null
      ? JSON.stringify(existingTrigger.args, null, 2)
      : "{}",
  );
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [runMode, setRunMode] = useState<"notify-only" | "read-only">(
    (existing?.runMode as "notify-only" | "read-only") ?? "notify-only",
  );
  /**
   * No default for a NEW automation — the user picks, exactly as the agent must.
   * This is the field that decides whether the automation can spend tokens in
   * chat, and a pre-selected radio is a decision made on the user's behalf while
   * looking like one they made.
   */
  const [notifyAgent, setNotifyAgent] = useState<boolean | null>(
    existing ? (existing.notifyAgent ?? false) : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const trigger = useMemo((): AutomationTrigger | null => {
    if (kind === "schedule") {
      return cron.trim() ? { kind: "schedule", cron: cron.trim() } : null;
    }
    if (kind === "github") {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim()) || events.length === 0) return null;
      return {
        kind: "github",
        repo: repo.trim(),
        events,
        intervalMinutes: Math.max(5, interval),
      };
    }
    if (mcpServerId == null || !mcpTool.trim()) return null;
    let args: unknown;
    try {
      args = mcpArgs.trim() ? JSON.parse(mcpArgs) : {};
    } catch {
      return null;
    }
    return {
      kind: "mcp",
      serverId: mcpServerId,
      tool: mcpTool.trim(),
      args,
      intervalMinutes: Math.max(5, interval),
    };
  }, [kind, cron, repo, events, interval, mcpServerId, mcpTool, mcpArgs]);

  const effectiveRunMode = runMode;
  const valid = Boolean(
    name.trim() &&
      trigger &&
      notifyAgent !== null &&
      (effectiveRunMode === "notify-only" || prompt.trim()),
  );

  const save = async () => {
    if (!valid || !trigger) return;
    setSaving(true);
    setError(null);
    const input = {
      name: name.trim(),
      enabled: existing?.enabled ?? true,
      trigger,
      prompt: prompt.trim(),
      runMode: effectiveRunMode,
      notifyAgent: notifyAgent === true,
      model: existing?.model ?? null,
    };
    try {
      if (existing) {
        await IpcClient.getInstance().updateAutomation(existing.id, input);
      } else {
        await IpcClient.getInstance().createAutomation(workspaceId, input);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const selectedMcpServer = mcpServers.find((s) => s.id === mcpServerId);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit automation" : "New automation"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Morning test audit"
            />
          </div>

          <Tabs value={kind} onValueChange={(v) => setKind(v as AutomationTrigger["kind"])}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="schedule">Schedule</TabsTrigger>
              <TabsTrigger value="github">GitHub</TabsTrigger>
              <TabsTrigger value="mcp">MCP</TabsTrigger>
            </TabsList>
          </Tabs>

          {kind === "schedule" && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {SCHEDULE_PRESETS.map((p) => (
                  <Button
                    key={p.key}
                    type="button"
                    size="sm"
                    variant={cron === p.cron ? "default" : "outline"}
                    onClick={() => setCron(p.cron)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="automation-cron">Cron expression</Label>
                <Input
                  id="automation-cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 9 * * 1-5"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Runs while Atlarix is open — missed fires are not caught up.
                </p>
              </div>
            </div>
          )}

          {kind === "github" && (
            <div className="space-y-2">
              <div className="space-y-1.5">
                <Label htmlFor="automation-repo">Repository (owner/name)</Label>
                <Input
                  id="automation-repo"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="owner/repo"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                {GITHUB_EVENTS.map((ev) => (
                  <label key={ev.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={events.includes(ev.key)}
                      onChange={(e) =>
                        setEvents((prev) =>
                          e.target.checked
                            ? [...prev, ev.key]
                            : prev.filter((k) => k !== ev.key),
                        )
                      }
                    />
                    {ev.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {kind === "mcp" && (
            <div className="space-y-2">
              <div className="space-y-1.5">
                <Label>MCP server</Label>
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={mcpServerId ?? ""}
                  onChange={(e) => setMcpServerId(Number(e.target.value))}
                >
                  {mcpServers.length === 0 && <option value="">No MCP servers configured</option>}
                  {mcpServers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="automation-mcp-tool">Tool name</Label>
                <Input
                  id="automation-mcp-tool"
                  value={mcpTool}
                  onChange={(e) => setMcpTool(e.target.value)}
                  placeholder="e.g. search_messages"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="automation-mcp-args">Arguments (JSON)</Label>
                <Textarea
                  id="automation-mcp-args"
                  value={mcpArgs}
                  onChange={(e) => setMcpArgs(e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                />
              </div>
              {selectedMcpServer && mcpTool.trim() && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Saving grants Atlarix standing consent to call {selectedMcpServer.name}/
                  {mcpTool.trim()} unattended on this schedule.
                </p>
              )}
            </div>
          )}

          {(kind === "github" || kind === "mcp") && (
            <div className="space-y-1.5">
              <Label htmlFor="automation-interval">Poll every (minutes, min 5)</Label>
              <Input
                id="automation-interval"
                type="number"
                min={5}
                value={interval}
                onChange={(e) => setIntervalMin(Number(e.target.value) || 5)}
                className="w-28"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>When it fires</Label>
            <div className="space-y-1.5">
              {(
                [
                  {
                    key: "notify-only" as const,
                    title: "Notify only (default)",
                    detail:
                      "Post the event to the feed + ping you — no model involved. Present it to the AI yourself with \"Send to chat\".",
                    disabled: false,
                  },
                  {
                    key: "read-only" as const,
                    title: "Run agent (read-only)",
                    detail:
                      "Runs an unattended agent turn with read-only tools and reports a summary. Costs one model turn per fire.",
                    disabled: false,
                  },
                ]
              ).map((opt) => (
                <label
                  key={opt.key}
                  className={cnRunMode(opt.disabled, runMode === opt.key)}
                >
                  <input
                    type="radio"
                    name="automation-run-mode"
                    className="mt-0.5"
                    checked={runMode === opt.key}
                    disabled={opt.disabled}
                    onChange={() => setRunMode(opt.key)}
                  />
                  <span>
                    <span className="block text-sm font-medium">{opt.title}</span>
                    <span className="block text-xs text-muted-foreground">{opt.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>When it fires, tell the AI?</Label>
            <div className="grid gap-2">
              {[
                {
                  key: false,
                  title: "No — just tell me",
                  detail:
                    "Shows in the run feed and notifies you. The AI is never woken, so this automation can't cost tokens. Good for Slack and other inbox-shaped noise you'll triage yourself.",
                },
                {
                  key: true,
                  title: "Yes — tell the AI",
                  detail:
                    "The result lands in the AI's next turn so it can act on it. Good for CI and tests. You can switch this off any time.",
                },
              ].map((opt) => (
                <label
                  key={String(opt.key)}
                  className={cnRunMode(false, notifyAgent === opt.key)}
                >
                  <input
                    type="radio"
                    name="automation-notify-agent"
                    className="mt-0.5"
                    checked={notifyAgent === opt.key}
                    onChange={() => setNotifyAgent(opt.key)}
                  />
                  <span>
                    <span className="block text-sm font-medium">{opt.title}</span>
                    <span className="block text-xs text-muted-foreground">{opt.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {runMode !== "notify-only" && (
            <div className="space-y-1.5">
              <Label htmlFor="automation-prompt">Prompt</Label>
              <Textarea
                id="automation-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="What should the agent do each time this fires?"
              />
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!valid || saving}>
            {saving ? "Saving…" : existing ? "Save changes" : "Create automation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
