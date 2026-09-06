/**
 * The bounded capability manifest — the driver's own ceiling, under ours.
 *
 * # Why this exists, and why it was missing
 *
 * The owner's decision was *"let it be full, except for replay"*, and the plan
 * specified `--permission-mode bounded --capability-manifest <path>
 * --approve-capability-manifest`. What actually shipped was
 * `["serve", "--embedded", "--socket", sock]` — no manifest, no permission mode.
 * `replay_trajectory` was not excluded; it was merely unreachable because the tool
 * surface was narrow, which is not the same thing at all. `computer_call` widens
 * that surface, so the difference stops being academic.
 *
 * TWO INDEPENDENT LAYERS, on purpose. `dispatch.ts` is Atlarix refusing; this is the
 * DRIVER refusing, enforced in a different process, from a file whose sha256 the
 * daemon reports back. A bug in our dispatch layer does not reach past this one.
 *
 * # The schema here is MEASURED, not guessed
 *
 * Derived on 2026-09-05 by feeding deliberate type errors to
 * `serve --permission-mode bounded` and reading serde's own "expected one of ..."
 * messages, then verifying a working manifest end to end (`list_apps` returned a
 * real list; `get_cursor_position`, absent from `allow.tools`, came back
 * `Permission denied: tool 'get_cursor_position' is outside the capability
 * manifest`). Four things that a plausible guess gets wrong:
 *
 *   - `expires_after` / `idle_timeout` are DURATION STRINGS ("24h"), not seconds.
 *     `86400` fails with "invalid duration unit in '86400'; expected s, m, or h".
 *   - `resources` is TOP-LEVEL, not under `allow` — `allow` accepts only `tools`.
 *   - `windows` accepts only the literal `"all"`; `terminate` accepts
 *     `deny | driver_launched | any`. Booleans are rejected.
 *   - Version 3 must NOT declare `mode`.
 *
 * Re-derive the same way before editing. Every one of those was a startup failure
 * on the first attempt.
 *
 * # What bounded mode COSTS, stated rather than discovered later
 *
 * A manifest expires. Past `expires_after` or `idle_timeout` every call fails with
 * a manifest error rather than a tool error, so the durations are generous and
 * `driver-session.ts` translates that refusal into "restart Atlarix" instead of
 * leaving a model to read it as a tool failure.
 *
 * And the resource lists must stay in step with what Atlarix actually does:
 * `files.write` has to contain the temp directory, because `ocr.ts` drives
 * `--screenshot-out-file` there and that is the `canonical_file_path_and_destination`
 * capability. Forget it and OCR breaks in bounded mode only — which is exactly the
 * kind of gap `self-test.ts` runs a real bounded daemon to catch.
 */
import os from "node:os";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { app } from "electron";
import { DENIED, DISPATCH, HOST_ONLY } from "./dispatch";

/**
 * How long the manifest is good for.
 *
 * Bounded mode REQUIRES both — "bounded mode requires capability manifest
 * expires_after and idle_timeout". Long enough that a normal working day never
 * trips it; short enough that a machine left running for a week re-authorises.
 */
const EXPIRES_AFTER = "24h";
const IDLE_TIMEOUT = "12h";

export interface CapabilityManifest {
  version: 3;
  expires_after: string;
  idle_timeout: string;
  resources: {
    desktop: { display: boolean };
    apps: Array<{
      bundle_id: string;
      windows?: "all";
      launch?: boolean;
      terminate?: "deny" | "driver_launched" | "any";
    }>;
    browser: { profiles: Array<{ kind: "isolated" | "existing_profile" }> };
    files: { write: string[] };
  };
  allow: { tools: string[] };
  deny: { tools: string[] };
}

/** Where a downloaded file may land. Inside userData, so nothing writes to $HOME. */
export function downloadRoot(): string {
  let base: string;
  try {
    base = app.getPath("userData");
  } catch {
    base = os.tmpdir();
  }
  return path.join(base, "computer-downloads");
}

export function manifestPath(): string {
  let base: string;
  try {
    base = app.getPath("userData");
  } catch {
    base = os.tmpdir();
  }
  return path.join(base, "cua-capability-manifest.json");
}

export function buildManifest(): CapabilityManifest {
  return {
    version: 3,
    expires_after: EXPIRES_AFTER,
    idle_timeout: IDLE_TIMEOUT,
    resources: {
      // `list_apps` needs this: without it even a listing returns
      // "desktop display observation is outside the capability manifest".
      desktop: { display: true },
      /**
       * ANY APP — the owner's decision, and the one place the manifest CANNOT
       * express our own rule.
       *
       * `apps` is an allowlist keyed by bundle id, `bundle_id: "*"` is the
       * wildcard, and the `windows` scope accepts only the literal `"all"`. There
       * is no per-app subtraction, so "every app except Atlarix" is not writable
       * here. The Atlarix exclusion therefore stays entirely ours
       * (`resolveTargetApp` / `resolveTargetPid` / `stripSelfFromResult`), and this
       * layer backs up the tool ceiling rather than the target rule.
       */
      apps: [{ bundle_id: "*", windows: "all", launch: true, terminate: "any" }],
      /**
       * `existing_profile` is the owner's browser decision expressed at the driver.
       *
       * The CLI's `--grant existing-profile` cannot be used for it: the driver
       * refuses with "--grant is valid only in standard permission mode". In
       * bounded mode the same capability is documented as `unattended_in_bounded`,
       * which is what this entry asserts — so the manifest is not merely an
       * alternative route to it, it is the only one compatible with bounded mode.
       */
      browser: { profiles: [{ kind: "existing_profile" }, { kind: "isolated" }] },
      /**
       * `--screenshot-out-file` is a governed capability
       * (`canonical_file_path_and_destination`), and `ocr.ts` uses it on every OCR
       * read. Omitting the temp directory here breaks tier-3 reads in bounded mode
       * and nowhere else.
       */
      files: { write: [os.tmpdir(), downloadRoot()] },
    },
    // Every tool Atlarix can legitimately reach: the model-facing set plus the
    // lifecycle tools the host itself calls. Sorted so the file — and its sha256,
    // which the daemon reports — is stable across runs.
    allow: { tools: [...Object.keys(DISPATCH), ...HOST_ONLY].sort() },
    // Belt and braces on the one list where it is warranted. `dispatch.ts` already
    // refuses these; this makes them refused even if that layer were bypassed.
    deny: { tools: Object.keys(DENIED).sort() },
  };
}

/**
 * Write the manifest and return its path.
 *
 * Rewritten on every spawn rather than cached: the tool lists come from
 * `dispatch.ts`, so a code change that alters them must not leave a stale ceiling
 * on disk — and a stale one fails CLOSED (a newly allowed tool is refused), which
 * is a confusing bug rather than a dangerous one, but a bug either way.
 */
export function writeManifest(): string {
  const file = manifestPath();
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(downloadRoot(), { recursive: true });
  writeFileSync(file, `${JSON.stringify(buildManifest(), null, 2)}\n`);
  return file;
}

/** True when a driver refusal is the manifest expiring rather than a real denial. */
export function isManifestExpiry(message: string): boolean {
  return /capability manifest (expired|idle timeout exceeded)/i.test(message);
}
