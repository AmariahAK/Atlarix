/**
 * Semgrep integration for PIVOT analysis layer.
 * Runs Semgrep CLI against workspace; optional custom path to semgrep.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";

export interface SemgrepConfig {
  /** Path to semgrep executable (default: "semgrep" in PATH) */
  executablePath?: string;
}

export interface SemgrepFinding {
  path: string;
  start: { line: number };
  end?: { line: number };
  message: string;
  severity: string;
  ruleId: string;
  metadata?: Record<string, unknown>;
}

export interface SemgrepResult {
  success: boolean;
  findings?: SemgrepFinding[];
  error?: string;
}

/**
 * Run Semgrep scan on workspacePath. Returns findings or error.
 * No-op if semgrep is not available (success: false, error message).
 */
export async function runSemgrepScan(
  workspacePath: string,
  config: SemgrepConfig | null = null,
): Promise<SemgrepResult> {
  const exe = config?.executablePath ?? "semgrep";
  return new Promise((resolve) => {
    const proc = spawn(
      exe,
      ["scan", "--json", "--quiet", "--no-git-ignore", "--max-target-bytes=0", "."],
      {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => {
      resolve({
        success: false,
        error: err.message ?? "Semgrep not found (install with: pip install semgrep)",
      });
    });
    proc.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        resolve({ success: false, error: stderr || `Exit code ${code}` });
        return;
      }
      try {
        const data = JSON.parse(stdout || "{}") as {
          results?: Array<{
            path: string;
            start: { line: number };
            end?: { line: number };
            extra?: { message?: string; severity?: string; metadata?: Record<string, unknown> };
            check_id?: string;
          }>;
        };
        const findings: SemgrepFinding[] = (data.results ?? []).map((r) => ({
          path: path.isAbsolute(r.path) ? r.path : path.join(workspacePath, r.path),
          start: r.start,
          end: r.end,
          message: r.extra?.message ?? "",
          severity: r.extra?.severity ?? "WARNING",
          ruleId: r.check_id ?? "",
          metadata: r.extra?.metadata,
        }));
        resolve({ success: true, findings });
      } catch {
        resolve({ success: false, error: "Semgrep output was not valid JSON" });
      }
    });
  });
}
