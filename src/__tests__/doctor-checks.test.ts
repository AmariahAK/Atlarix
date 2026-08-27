/**
 * The doctor's shape, and the two ways it could rot silently.
 *
 * 1. It REUSES self-test probes by name (`reuse("sqlite", …)`). A rename upstream
 *    would drop a row from the panel with nothing failing — so the lookup throws,
 *    and this asserts it.
 * 2. Every failing row must carry a remediation. A red row with no next step just
 *    relocates the confusion, which is the failure mode this whole feature exists
 *    to fix.
 */
import { describe, expect, it, vi } from "vitest";
import { DOCTOR_CHECKS, runDoctor, type DoctorCheck } from "@/main/doctor";

describe("the doctor's check list", () => {
  it("resolves every reused self-test probe", () => {
    // Importing the module is the assertion: `reuse()` throws at module scope if a
    // probe name no longer exists, so a rename upstream fails the build rather
    // than quietly shrinking the panel.
    expect(DOCTOR_CHECKS.length).toBeGreaterThan(0);
    for (const check of DOCTOR_CHECKS) {
      expect(typeof check.run, check.name).toBe("function");
    }
  });

  it("gives every check a title, an explanation and a remediation", () => {
    for (const check of DOCTOR_CHECKS) {
      expect(check.title, check.name).toBeTruthy();
      expect(check.what, check.name).toBeTruthy();
      expect(check.remediation, check.name).toBeTruthy();
      expect(["warn", "fail"], check.name).toContain(check.severityWhenFailed);
    }
  });

  it("has unique names, since the panel keys rows on them", () => {
    const names = DOCTOR_CHECKS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // The panel must not run the probes that exist for CI's benefit: those spawn
  // shells and write outside the container.
  it("excludes the probes that are inappropriate in front of a user", () => {
    const names = DOCTOR_CHECKS.map((c) => c.name);
    expect(names).not.toContain("child-exec");
    expect(names).not.toContain("fs-outside-container");
  });

  // Updates are owned by `UpdateDiagnostics` in the renderer. A probe here would
  // give the panel two answers about updates that could disagree.
  it("does not duplicate the update check", () => {
    expect(DOCTOR_CHECKS.map((c) => c.name)).not.toContain("update");
  });
});

describe("runDoctor", () => {
  const fakeChecks: DoctorCheck[] = [
    {
      name: "green",
      title: "A passing check",
      what: "Proves nothing, quickly.",
      remediation: "Nothing to do.",
      severityWhenFailed: "fail",
      run: async () => "all good",
    },
    {
      name: "amber",
      title: "A degraded check",
      what: "Something optional is unavailable.",
      remediation: "Check your network.",
      docPath: "models",
      severityWhenFailed: "warn",
      run: async () => {
        throw new Error("offline");
      },
    },
    {
      name: "red",
      title: "A broken check",
      what: "Something required is unavailable.",
      remediation: "Reinstall Atlarix.",
      severityWhenFailed: "fail",
      run: async () => {
        throw new Error("missing binding");
      },
    },
  ];

  it("maps each probe outcome to a row with its own severity", async () => {
    const report = await runDoctor(fakeChecks);
    const byName = new Map(report.rows.map((r) => [r.name, r]));

    expect(byName.get("green")?.ok).toBe(true);
    expect(byName.get("green")?.severity).toBe("ok");
    // A passing row carries no remediation — there is nothing to remedy, and
    // showing one anyway reads as a warning.
    expect(byName.get("green")?.remediation).toBeUndefined();

    // The distinction that matters: degraded is not broken. An offline catalog
    // still leaves a working app, and colouring it red would train people to
    // ignore red.
    expect(byName.get("amber")?.severity).toBe("warn");
    expect(byName.get("amber")?.remediation).toBe("Check your network.");
    expect(byName.get("amber")?.docPath).toBe("models");

    expect(byName.get("red")?.severity).toBe("fail");
    expect(byName.get("red")?.detail).toContain("missing binding");
  });

  it("reports the environment the checks ran in", async () => {
    const report = await runDoctor([fakeChecks[0]]);
    expect(report.appVersion).toBeTruthy();
    expect(report.platform).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
    expect(report.generatedAt).toBeGreaterThan(0);
  });

  // A thrown probe must become a row, not an exception: one broken check cannot
  // be allowed to take the whole report down, or the panel shows nothing exactly
  // when it is most needed.
  it("never rejects, however badly a check fails", async () => {
    const exploding: DoctorCheck[] = [
      {
        name: "boom",
        title: "Throws a non-Error",
        what: "…",
        remediation: "…",
        severityWhenFailed: "fail",
        run: async () => {
          throw "not an Error object";
        },
      },
    ];
    const report = await runDoctor(exploding);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].ok).toBe(false);
  });
});

/**
 * The provider-keys row must name the cause it actually hit.
 *
 * THE BUG THIS LOCKS DOWN. It used to be a bare `catch {}` that answered "the local
 * database is unavailable" for every possible failure — and the Local database row's
 * remediation is "reinstall Atlarix". So a packaged `--doctor` on a healthy machine
 * told the user to reinstall, over a defect in the CLI path itself (`--doctor` never
 * called `initializeDatabase()`), while the sqlite row said OK three lines below.
 *
 * Two rows contradicting each other is the signature, and a check that names one
 * cause for every failure will mislead again.
 */
describe("the provider-keys check", () => {
  it("reports the underlying error rather than blaming the database", async () => {
    const check = DOCTOR_CHECKS.find((c) => c.name === "provider-keys");
    expect(check).toBeDefined();

    vi.doMock("@/ipc/shared/provider_api_keys", () => ({
      getProviderApiKey: async () => undefined,
      getConfiguredProviders: async () => {
        throw new Error("Database not initialized. Call initializeDatabase() first.");
      },
    }));
    vi.resetModules();
    const { DOCTOR_CHECKS: fresh } = await import("@/main/doctor");
    const providerKeys = fresh.find((c) => c.name === "provider-keys")!;

    await expect(providerKeys.run()).rejects.toThrow(/Database not initialized/);
    await expect(providerKeys.run()).rejects.not.toThrow(/local database is unavailable/);

    vi.doUnmock("@/ipc/shared/provider_api_keys");
    vi.resetModules();
  });
});
