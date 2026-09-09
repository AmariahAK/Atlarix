/**
 * Diagnostics — the in-app doctor.
 *
 * The checks that run here are the ones behind our actual support burden: an
 * update that will not install, Core unreachable, a key that stopped working, a
 * sandbox that silently ran unconfined. Each row therefore has to answer three
 * things — what was checked, what happened, and what to DO — because a red row
 * with no next step just relocates the confusion.
 *
 * Updates are NOT a probe here: `UpdateDiagnostics` already owns that surface
 * completely (current version, last check, result, one-click install), and it is
 * rendered inside this section rather than duplicated as a row that could
 * disagree with it.
 *
 * Nothing runs on mount. A panel that fires network calls and a sandbox probe
 * because you scrolled past it is doing work nobody asked for; the button is the
 * consent.
 */

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Loader2,
  Stethoscope,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showSuccess } from "@/lib/toast";
import { UpdateDiagnostics } from "@/components/settings/UpdateDiagnostics";
import type { DoctorReport, DoctorRow } from "@/main/doctor";

const DOCS_BASE = "https://www.atlarix.dev/docs";

function RowIcon({ row }: { row: DoctorRow }) {
  if (row.ok)
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />;
  if (row.severity === "warn")
    return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />;
  return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
}

function CheckRow({ row }: { row: DoctorRow }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/60 p-3">
      <div className="pt-0.5">
        <RowIcon row={row} />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-foreground">
            {row.title}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {row.ms}ms
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{row.what}</p>
        {row.detail ? (
          // `break-words`: a probe detail can be a provider error message with no
          // spaces in it, and one of those must not widen the settings page.
          <p className="text-xs text-foreground/80 break-words">{row.detail}</p>
        ) : null}
        {!row.ok && row.remediation ? (
          <p className="text-xs text-foreground/90">
            <span className="font-medium">What to do: </span>
            {row.remediation}
            {row.docPath ? (
              <>
                {" "}
                <a
                  href={`${DOCS_BASE}/${row.docPath}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:no-underline"
                >
                  Read more
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function DiagnosticsPanel() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState(false);
  const [copying, setCopying] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      setReport(await IpcClient.getInstance().runDoctor());
    } catch (e) {
      showError(e instanceof Error ? e.message : "Diagnostics failed to run");
    } finally {
      setRunning(false);
    }
  }, []);

  const copy = useCallback(async () => {
    setCopying(true);
    try {
      // Formatted (and redacted) in main. The renderer never assembles this text.
      const text = await IpcClient.getInstance().copyDoctorReport();
      await navigator.clipboard.writeText(text);
      showSuccess("Report copied — safe to paste, keys and paths removed");
    } catch (e) {
      showError(e instanceof Error ? e.message : "Could not copy the report");
    } finally {
      setCopying(false);
    }
  }, []);

  const failing = report?.rows.filter((r) => !r.ok) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-medium text-foreground">
            <Stethoscope className="h-5 w-5" />
            Diagnostics
          </h2>
          <p className="text-sm text-muted-foreground">
            Check the parts of Atlarix that fail quietly — your account, your
            keys, the model catalog, and the pieces bundled inside the app.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => void run()} disabled={running} size="sm">
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Running…
              </>
            ) : (
              "Run checks"
            )}
          </Button>
          {report ? (
            <Button
              onClick={() => void copy()}
              disabled={copying}
              size="sm"
              variant="outline"
            >
              <ClipboardCopy className="mr-2 h-4 w-4" />
              {copying ? "Copying…" : "Copy report"}
            </Button>
          ) : null}
        </div>
      </div>

      {report ? (
        <>
          <div className="text-xs text-muted-foreground">
            {failing.length === 0
              ? `All ${report.rows.length} checks passed.`
              : `${failing.length} of ${report.rows.length} checks need attention.`}{" "}
            Atlarix {report.appVersion} · {report.platform}/{report.arch}
          </div>
          <div className="space-y-2">
            {report.rows.map((row) => (
              <CheckRow key={row.name} row={row} />
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing has been checked yet. Running takes a few seconds and sends
          nothing anywhere — the results stay on this screen until you copy
          them.
        </p>
      )}

      <div className="border-t border-border pt-4">
        <UpdateDiagnostics />
      </div>
    </div>
  );
}
