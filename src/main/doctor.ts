/**
 * The in-app doctor.
 *
 * `self-test:packaged` proves a BUILD is sound, and it is a developer tool: it
 * runs headless, exits a process, and is unreachable from the app. What users
 * actually report is a different list — an update that will not install, Core
 * unreachable, a provider key that stopped working, an offline start, a sandbox
 * that silently ran unconfined. Every one of those is diagnosable in seconds and
 * currently costs a support round trip.
 *
 * This reuses the self-test's `SelfTestProbe` contract and `runSelfTest` runner
 * rather than growing a second one, with a much smaller per-check budget (45s per
 * probe is fine for CI and unusable in front of a person). The native and sandbox
 * checks ARE the self-test's own probes, imported, not reimplemented — a
 * diagnostic that tests a copy of the thing tells you nothing about the thing.
 *
 * Deliberately excluded from the reused set: `child-exec` and
 * `fs-outside-container`, which spawn shells and write outside the container for
 * CI's benefit. A user-facing panel should not do either.
 */

import log from "electron-log";
import { app } from "electron";
import {
  DEFAULT_PROBES,
  runSelfTest,
  type SelfTestProbe,
} from "./self-test";
import { describeAllowanceUsed, formatCents } from "@/shared/billing_copy";

const logger = log.scope("doctor");

/** A person is watching. Long enough for a cold network call, short enough to sit through. */
const DOCTOR_TIMEOUT_MS = 12_000;

export type DoctorSeverity = "ok" | "warn" | "fail";

export type DoctorCheck = SelfTestProbe & {
  /** Human title for the row. */
  title: string;
  /** One line on what this proves, shown under the title. */
  what: string;
  /**
   * What to DO when it fails. A diagnostic that reports a red row without a next
   * step just relocates the confusion.
   */
  remediation: string;
  /** Path under atlarix.dev/docs, when an article covers it. */
  docPath?: string;
  /**
   * `warn` for a check whose failure degrades something without breaking it — an
   * offline model catalog still leaves the picker working off the bundled
   * snapshot. `fail` for something the user cannot work around.
   */
  severityWhenFailed: DoctorSeverity;
};

export type DoctorRow = {
  name: string;
  title: string;
  what: string;
  ok: boolean;
  severity: DoctorSeverity;
  detail: string;
  remediation?: string;
  docPath?: string;
  ms: number;
};

export type DoctorReport = {
  generatedAt: number;
  appVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
  rows: DoctorRow[];
};

/** Reuse a self-test probe verbatim, with the user-facing copy layered on. */
function reuse(
  name: string,
  meta: Omit<DoctorCheck, keyof SelfTestProbe>,
): DoctorCheck {
  const probe = DEFAULT_PROBES.find((p) => p.name === name);
  if (!probe) {
    // A rename upstream must not silently drop a row from the panel.
    throw new Error(`doctor: no self-test probe named "${name}"`);
  }
  return { ...probe, ...meta };
}

/**
 * Atlarix Core reachability, told apart from being signed out and from an empty
 * balance — three different problems that all present as "Core doesn't work".
 */
const coreCheck: DoctorCheck = {
  name: "atlarix-core",
  title: "Atlarix Core",
  what: "Signed in, and our proxy is reachable.",
  remediation:
    "If it says signed out, sign in from the sidebar. If the balance is $0.00, top up from Account. If you are on a paid plan and the included usage reads $0.00 mid-period, the monthly grant did not renew — that is a billing problem, not an empty wallet. If the proxy is unreachable, check a VPN or corporate proxy — your own API keys and local models keep working either way.",
  docPath: "help/ai-rate-limit",
  severityWhenFailed: "warn",
  run: async () => {
    const { getSession, getSupabaseClient } = await import(
      "../lib/auth/supabase-client"
    );
    const session = await getSession().catch(() => null);
    if (!session) {
      throw new Error(
        "Not signed in — Core is unavailable until you sign in (your own API keys and local models are unaffected).",
      );
    }
    // The same RPC the usage card and the low-balance nudge read, so a green row
    // here means the thing those cards use actually works — not a parallel path
    // that happens to be healthy.
    const { data, error } = await getSupabaseClient().rpc("get_credit_balance");
    if (error) {
      throw new Error(`Signed in, but the balance could not be read: ${error.message}`);
    }
    // `balance_cents` is the SPENDABLE total — the month's included usage plus
    // purchased credit. The split is reported alongside it because the two fail
    // for different reasons: an allowance at zero on a paid plan mid-period is a
    // grant that did not renew, which looks identical to an empty wallet if you
    // only print the total.
    const row = data as {
      ok?: boolean;
      balance_cents?: number;
      granted_cents?: number;
      granted_total_cents?: number;
      purchased_cents?: number;
    } | null;
    const cents = Number(row?.balance_cents ?? 0);
    if (row?.ok === false) {
      throw new Error("Signed in, but the account is not in good standing.");
    }
    // Reported as CONSUMED, matching the card. "$0.27 of $1,000,000.00 used" says
    // whether the allowance is being drawn down; "$999,999.73 included" does not,
    // and the difference is the whole reason the period total exists.
    const split =
      typeof row?.granted_cents === "number" && typeof row?.purchased_cents === "number"
        ? typeof row?.granted_total_cents === "number" && row.granted_total_cents > 0
          ? ` (${describeAllowanceUsed(row.granted_total_cents - row.granted_cents, row.granted_total_cents)} of this month's included usage, ${formatCents(row.purchased_cents)} purchased)`
          : ` (no allowance this period, ${formatCents(row.purchased_cents)} purchased)`
        : "";
    if (cents <= 0) {
      throw new Error(
        `Reachable, but the spendable balance is ${formatCents(cents)}${split} — Core requests will be refused until you top up.`,
      );
    }
    return `signed in, proxy reachable, balance ${formatCents(cents)}${split}`;
  },
};

/**
 * The model catalog. A failure here is a WARN by design: the picker falls back to
 * the snapshot shipped inside the app, so the user is not blocked — they are just
 * looking at an older list than they think.
 */
const catalogCheck: DoctorCheck = {
  name: "model-catalog",
  title: "Model catalog",
  what: "The models.dev catalog refreshed, rather than falling back to the bundled snapshot.",
  remediation:
    "Usually a network or proxy block on models.dev. The picker keeps working from the snapshot that ships with the app, so this only means new models may be missing.",
  docPath: "models",
  severityWhenFailed: "warn",
  run: async () => {
    const { getModelsDevData } = await import("../lib/models_dev");
    const data = await getModelsDevData();
    const providers = Object.keys(data ?? {}).length;
    if (providers === 0) {
      throw new Error(
        "No catalog data at all — neither a refresh nor the bundled snapshot loaded.",
      );
    }
    return `${providers} providers available`;
  },
};

/**
 * Whether the OS credential store actually round-trips.
 *
 * This is the v14.27.0 class of failure — stored provider keys and the Supabase
 * session becoming undecryptable — and it is invisible until the user is
 * mysteriously signed out or a saved key stops working. The probe value is a
 * throwaway; nothing real is decrypted here.
 */
const credentialStoreCheck: DoctorCheck = {
  name: "credential-store",
  title: "Credential store",
  what: "The OS keychain can encrypt and decrypt, so saved keys and your session survive a restart.",
  remediation:
    "On macOS this usually means the keychain denied access to the app — check Keychain Access, or reinstall. Until it works, provider keys and your sign-in will not persist across restarts.",
  docPath: "help/diagnostics",
  severityWhenFailed: "fail",
  run: async () => {
    const { safeStorage } = await import("electron");
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS encryption is unavailable, so credentials cannot be stored safely.",
      );
    }
    const probe = `atlarix-doctor-${Date.now()}`;
    const round = safeStorage.decryptString(safeStorage.encryptString(probe));
    if (round !== probe) {
      throw new Error("Encrypt/decrypt round trip did not return what went in.");
    }
    return "encrypt/decrypt round trip OK";
  },
};

/**
 * Every configured BYOK key, checked in ONE row.
 *
 * A models-list call, never a completion — so nothing is billed to the user for
 * running a diagnostic. That distinction is the whole design constraint here: the
 * obvious way to test a key is to use it, and the obvious way costs money.
 *
 * One row rather than one per provider, and all providers in parallel, because
 * the interesting answer is "which of your keys stopped working" — a list of
 * seven green rows is noise, and seven sequential network calls would blow the
 * budget a person will sit through.
 */
const providerKeysCheck: DoctorCheck = {
  name: "provider-keys",
  title: "Your API keys",
  what: "Each key you have saved still authenticates with its provider.",
  remediation:
    "Re-enter the failing key under Settings → AI. A key that worked yesterday and fails today is usually revoked, expired, or out of quota at the provider.",
  docPath: "models",
  severityWhenFailed: "warn",
  run: async () => {
    /**
     * Reading saved keys needs the local database, and a dead database is
     * exactly the situation this tool exists for: on a DB init failure the app
     * shows a modal and QUITS, so Settings → Diagnostics is unreachable and
     * `--doctor` is the only way in. It must therefore report "cannot check"
     * rather than surfacing a raw native ABI error under a row about API keys,
     * which would send someone to re-enter keys that are fine.
     */
    let providers: string[];
    let getProviderApiKey: (id: string) => Promise<string | undefined>;
    try {
      const mod = await import("../ipc/shared/provider_api_keys");
      getProviderApiKey = mod.getProviderApiKey;
      providers = await mod.getConfiguredProviders();
    } catch {
      throw new Error(
        "Could not read your saved keys — the local database is unavailable. Fix the Local database row first; this check says nothing about whether your keys are valid.",
      );
    }
    if (providers.length === 0) {
      // Not a failure. Plenty of people use only Core, or only local models.
      return "no keys saved — nothing to check";
    }
    const { fetchModelsFromProvider } = await import(
      "../lib/provider_model_fetchers"
    );
    const { getProviderApiBaseUrl } = await import("../lib/models_dev");

    const outcomes = await Promise.all(
      providers.map(async (providerId) => {
        try {
          const apiKey = await getProviderApiKey(providerId);
          if (!apiKey) return { providerId, ok: false, why: "no key stored" };
          const baseUrl = await getProviderApiBaseUrl(providerId).catch(
            () => undefined,
          );
          const models = await fetchModelsFromProvider(
            providerId,
            apiKey,
            baseUrl ?? undefined,
          );
          // An empty list is NOT a failure: a provider with no bespoke fetcher and
          // no known base URL is catalog-only by design, and reporting that as a
          // bad key would send people to re-enter a key that is fine.
          return { providerId, ok: true, why: `${models.length} models` };
        } catch (e) {
          return {
            providerId,
            ok: false,
            // Never interpolate the key — only the provider's own message.
            why: e instanceof Error ? e.message.slice(0, 120) : "failed",
          };
        }
      }),
    );

    const bad = outcomes.filter((o) => !o.ok);
    if (bad.length > 0) {
      throw new Error(
        `${bad.length} of ${outcomes.length} keys failed: ` +
          bad.map((b) => `${b.providerId} (${b.why})`).join("; "),
      );
    }
    return `${outcomes.length} key(s) OK: ${outcomes.map((o) => o.providerId).join(", ")}`;
  },
};

/**
 * The doctor's check list.
 *
 * Update connectivity is NOT here: `UpdateDiagnostics` already owns it in the
 * renderer, with the current version, the last check, its result and a one-click
 * install. Duplicating it as a probe would give the panel two answers about
 * updates that could disagree.
 */
export const DOCTOR_CHECKS: DoctorCheck[] = [
  coreCheck,
  providerKeysCheck,
  catalogCheck,
  credentialStoreCheck,
  reuse("sqlite", {
    title: "Local database",
    what: "The native sqlite module loads and can read and write.",
    remediation:
      "This means a broken or partial install — reinstall Atlarix. Your workspaces and chats are stored outside the app, so they survive a reinstall.",
    docPath: "help/diagnostics",
    severityWhenFailed: "fail",
  }),
  reuse("ripgrep", {
    title: "Search",
    what: "Bundled ripgrep resolves and runs, which is how the agent searches your code.",
    remediation:
      "Reinstall Atlarix. If your organisation strips bundled binaries, ripgrep is the file to allow-list.",
    docPath: "help/diagnostics",
    severityWhenFailed: "fail",
  }),
  reuse("pty-spawn", {
    title: "Terminal",
    what: "A real shell can be spawned, for terminal tabs and agent commands.",
    remediation:
      "Reinstall Atlarix. On Windows this can also be an endpoint-protection block on the spawn helper.",
    docPath: "help/diagnostics",
    severityWhenFailed: "fail",
  }),
  reuse("proxy-worker", {
    title: "Local proxy worker",
    what: "The worker that carries provider traffic resolves from inside the packaged app.",
    remediation: "Reinstall Atlarix.",
    docPath: "help/diagnostics",
    severityWhenFailed: "fail",
  }),
  reuse("sandbox", {
    title: "Command sandbox",
    what: "Shell commands run confined, so a command cannot write outside your workspace.",
    remediation:
      "Commands still run, but WITHOUT write confinement — approve them more carefully until this is fixed. On Windows this is usually a privilege the account does not hold.",
    docPath: "guides/approvals",
    // Deliberately `fail`: the app keeps working, but a containment guarantee the
    // product makes is not being met, and the user should know before approving
    // the next command rather than after.
    severityWhenFailed: "fail",
  }),
];

export async function runDoctor(
  checks: DoctorCheck[] = DOCTOR_CHECKS,
): Promise<DoctorReport> {
  const { results } = await runSelfTest(checks, {
    timeoutMs: DOCTOR_TIMEOUT_MS,
    noOutFile: true,
  });

  const byName = new Map(checks.map((c) => [c.name, c]));
  const rows: DoctorRow[] = results.map((r) => {
    const check = byName.get(r.name);
    return {
      name: r.name,
      title: check?.title ?? r.name,
      what: check?.what ?? "",
      ok: r.ok,
      severity: r.ok ? "ok" : (check?.severityWhenFailed ?? "fail"),
      detail: r.detail,
      ...(r.ok ? {} : { remediation: check?.remediation }),
      ...(r.ok ? {} : { docPath: check?.docPath }),
      ms: r.ms,
    };
  });

  const failed = rows.filter((r) => !r.ok).length;
  logger.info(
    `[doctor] ${rows.length - failed}/${rows.length} checks OK` +
      (failed ? ` — failing: ${rows.filter((r) => !r.ok).map((r) => r.name).join(", ")}` : ""),
  );

  return {
    generatedAt: Date.now(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    rows,
  };
}
