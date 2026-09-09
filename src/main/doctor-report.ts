/**
 * Render a doctor report as text a user can paste to support — with the secrets
 * taken out.
 *
 * This is the highest-value output of the panel and the only part with a hard
 * safety constraint, so it lives in its own file with its own tests. A support
 * blob is pasted into chat, email and issue trackers; whatever is in it is public
 * from that moment. Three things must therefore never appear:
 *
 * - **Key material.** Probe details are built from provider error messages, and
 *   providers do echo credentials back ("Incorrect API key provided: sk-…").
 * - **Absolute paths.** They carry the user's real name far more often than
 *   people expect, and a home directory is not ours to publish.
 * - **The user's email.** It identifies them to us; it is not a field to ship
 *   into a blob whose destination we do not control.
 *
 * The redaction is deliberately shape-based rather than a list of known key
 * formats. A new provider with a new prefix must not silently become a leak, so
 * anything that LOOKS like a long opaque token goes, whether or not we recognize
 * it.
 */

import type { DoctorReport, DoctorRow } from "./doctor";

/** What a redacted span is replaced with, so the reader knows something was cut. */
const MASK = "[redacted]";

/**
 * Ordered because the earlier patterns are the specific ones; the last is the
 * broad "long opaque token" net that catches formats nobody has seen yet.
 */
const SECRET_PATTERNS: RegExp[] = [
  // `Authorization: Bearer <token>` / `Proxy-Authorization: Basic <token>`.
  //
  // The scheme word has to be consumed EXPLICITLY. A single pattern of
  // `(?:bearer|authorization)\s*[:=]?\s*\S+` looks equivalent and is not: on
  // "Authorization: Bearer sk-live-…" it matches the header name plus the word
  // "Bearer" as its value and leaves the actual token in the text. Caught by the
  // test below, which is why that test enumerates separators.
  /\b(?:proxy-)?authorization\b\s*[:=]\s*(?:bearer|basic|token|digest)?\s*\S+/gi,
  // A bare `Bearer <token>`, with no header name in front of it.
  /\bbearer\s+\S+/gi,
  // `key=…`, `api_key: …`, `token = …`, quoted or not.
  /\b(?:api[-_]?key|secret|token|password|passwd|pwd|refresh[-_]?token|access[-_]?token)\b\s*[:=]\s*["']?[^\s"',;)]+["']?/gi,
  // Known-shape provider keys, kept for a clearer mask on the common cases.
  /\b(?:sk|pk|rk|xai|gsk|sk-ant|sk-or|sk-proj)-[A-Za-z0-9_-]{8,}/g,
  // JWTs (three base64url segments) — a Supabase session, typically.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Anything else long, opaque and token-shaped. Requires a digit AND a letter so
  // ordinary long words and hyphenated prose survive.
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{28,}\b/g,
];

/** Email addresses — the user's own, or anyone else's. */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Absolute paths, POSIX and Windows, replaced by their last segment.
 *
 * The filename is usually the informative part ("better_sqlite3.node"), while
 * everything to its left is the user's identity and machine layout.
 */
const POSIX_PATH =
  /(?:\/(?:Users|home|var|tmp|private|opt|Volumes|mnt)\/)[^\s"',;:)]+/g;
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"',;)]+/g;

function lastSegment(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts.length ? `…/${parts[parts.length - 1]}` : MASK;
}

/**
 * Strip anything that identifies the user or authenticates as them.
 *
 * Exported for its own test: the guarantee this function makes is the reason the
 * copy button is safe to offer, so it is asserted directly rather than inferred
 * from the panel's output.
 */
export function redactForSupport(text: string): string {
  if (!text) return "";
  let out = text;
  out = out.replace(EMAIL, MASK);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  out = out.replace(POSIX_PATH, (m) => lastSegment(m));
  out = out.replace(WINDOWS_PATH, (m) => lastSegment(m));
  return out;
}

function statusLabel(row: DoctorRow): string {
  if (row.ok) return "OK  ";
  return row.severity === "warn" ? "WARN" : "FAIL";
}

/**
 * The pasteable report.
 *
 * Version, platform and arch are included deliberately — they are the first three
 * questions support asks, they are not personal, and leaving them out is what
 * makes a support thread take four messages instead of one.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("Atlarix diagnostics");
  lines.push(
    `version ${report.appVersion} · ${report.platform}/${report.arch} · ${
      report.packaged ? "packaged" : "dev"
    }`,
  );
  lines.push(new Date(report.generatedAt).toISOString());
  lines.push("");

  for (const row of report.rows) {
    lines.push(`${statusLabel(row)}  ${row.title} (${row.ms}ms)`);
    if (row.detail) lines.push(`      ${redactForSupport(row.detail)}`);
  }

  const failing = report.rows.filter((r) => !r.ok);
  lines.push("");
  lines.push(
    failing.length === 0
      ? `All ${report.rows.length} checks passed.`
      : `${failing.length} of ${report.rows.length} checks failed: ${failing
          .map((r) => r.name)
          .join(", ")}`,
  );
  return lines.join("\n");
}
