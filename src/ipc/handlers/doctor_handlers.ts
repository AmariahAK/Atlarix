/**
 * Diagnostics ("doctor") IPC.
 *
 * Two channels, and the split matters: the renderer gets the STRUCTURED report so
 * it can render per-row severity and remediation, and asks main separately for
 * the pasteable TEXT. Formatting in the renderer would put the redaction — the one
 * hard safety constraint here — on the far side of the process boundary from the
 * data it protects, and behind a component that is easy to change without
 * noticing what it now leaks.
 */

import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { runDoctor, type DoctorReport } from "../../main/doctor";
import { formatDoctorReport } from "../../main/doctor-report";

const logger = log.scope("doctor_handlers");
const handle = createLoggedHandler(logger);

/**
 * The last report, kept so "Copy report" formats exactly what the user is looking
 * at rather than silently re-running the checks and copying a different answer.
 */
let lastReport: DoctorReport | null = null;

export function registerDoctorHandlers(): void {
  // No auth gate: a diagnostic has to work when auth is exactly what is broken.
  // That is the whole point of the Core row, which reports "not signed in" as a
  // finding rather than refusing to run.
  handle("doctor:run", async () => {
    lastReport = await runDoctor();
    return lastReport;
  });

  handle("doctor:copy-report", async () => {
    const report = lastReport ?? (await runDoctor());
    lastReport = report;
    return formatDoctorReport(report);
  });
}
