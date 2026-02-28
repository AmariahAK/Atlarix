/**
 * PIVOT analysis panel — run SonarQube/Semgrep and show findings.
 */

import { useState, useCallback } from "react";
import { useAtomValue } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Shield, Bug, FileCode } from "lucide-react";

interface AnalysisResult {
  sonar: { success: boolean; issues?: Array<{ file: string; line?: number; message: string; severity: string; rule: string }>; error?: string };
  semgrep: { success: boolean; findings?: Array<{ path: string; start: { line: number }; message: string; severity: string; ruleId: string }>; error?: string };
  scip: { success: boolean; symbols?: unknown[]; error?: string };
}

interface PivotAnalysisPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PivotAnalysisPanel({ open, onOpenChange }: PivotAnalysisPanelProps) {
  const app = useAtomValue(currentAppAtom);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);

  const runAnalysis = useCallback(async () => {
    if (!app?.id) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await IpcClient.getInstance().runPivotAnalysis({ workspaceId: app.id });
      if (res.success && res.result) {
        setResult(res.result);
        const total = (res.result.sonar.issues?.length ?? 0) + (res.result.semgrep.findings?.length ?? 0);
        toast.success(`Analysis complete. ${total} finding(s).`);
      } else {
        toast.error(res.error ?? "Analysis failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setRunning(false);
    }
  }, [app?.id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col gap-4" showCloseButton>
        <DialogHeader>
          <DialogTitle>PIVOT Analysis</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Run SonarQube (set SONAR_URL, SONAR_TOKEN, SONAR_PROJECT_KEY) and Semgrep (install: pip install semgrep).
        </p>
        <button
          type="button"
          onClick={runAnalysis}
          disabled={running || !app?.id}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded border border-border bg-muted/80 hover:bg-muted disabled:opacity-50"
        >
          <Shield className="w-4 h-4" />
          {running ? "Running…" : "Run analysis"}
        </button>
        {result && (
          <div className="flex flex-col gap-4 overflow-auto min-h-0">
            {result.sonar.success && result.sonar.issues && result.sonar.issues.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground flex items-center gap-1 mb-2">
                  <Bug className="w-3 h-3" /> SonarQube ({result.sonar.issues.length})
                </h4>
                <ul className="text-xs space-y-1 max-h-40 overflow-auto">
                {result.sonar.issues.slice(0, 30).map((i, idx) => (
                  <li key={`${i.file}-${i.line ?? ""}-${idx}`} className="flex gap-2">
                      <span className="text-muted-foreground shrink-0">{i.file}:{i.line ?? "?"}</span>
                      <span className="truncate">{i.message}</span>
                      <span className="shrink-0 text-amber-600">{i.severity}</span>
                    </li>
                  ))}
                  {result.sonar.issues.length > 30 && (
                    <li className="text-muted-foreground">+{result.sonar.issues.length - 30} more</li>
                  )}
                </ul>
              </div>
            )}
            {result.sonar.error && (
              <p className="text-xs text-muted-foreground">SonarQube: {result.sonar.error}</p>
            )}
            {result.semgrep.success && result.semgrep.findings && result.semgrep.findings.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground flex items-center gap-1 mb-2">
                  <FileCode className="w-3 h-3" /> Semgrep ({result.semgrep.findings.length})
                </h4>
                <ul className="text-xs space-y-1 max-h-40 overflow-auto">
                  {result.semgrep.findings.slice(0, 30).map((f, idx) => (
                    <li key={`${f.path}-${idx}`} className="flex gap-2">
                      <span className="text-muted-foreground shrink-0">{f.path}:{f.start.line}</span>
                      <span className="truncate">{f.message}</span>
                      <span className="shrink-0 text-amber-600">{f.severity}</span>
                    </li>
                  ))}
                  {result.semgrep.findings.length > 30 && (
                    <li className="text-muted-foreground">+{result.semgrep.findings.length - 30} more</li>
                  )}
                </ul>
              </div>
            )}
            {result.semgrep.error && (
              <p className="text-xs text-muted-foreground">Semgrep: {result.semgrep.error}</p>
            )}
            {!result.sonar.issues?.length && !result.semgrep.findings?.length && !result.sonar.error && !result.semgrep.error && (
              <p className="text-xs text-muted-foreground">No findings. Configure SonarQube env vars or install Semgrep.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
