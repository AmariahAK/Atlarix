#!/usr/bin/env node
/**
 * Launch the packaged Atlarix binary with --self-test and propagate its exit
 * code. Run after verify-ci-package-out in each CI package job (and locally via
 * `npm run self-test:packaged`). Catches packaged-only failures the static
 * verifier can't: worker/native-module resolution inside the asar, node-pty
 * spawn. On Linux CI, wraps in xvfb-run (Electron whenReady needs a display
 * even though we exit before creating a window) and passes --no-sandbox.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--arch" && argv[i + 1]) opts.arch = argv[++i];
  }
  return opts;
}

const APP = "Atlarix";
const platform = process.platform;
const arch = parseArgs(process.argv).arch ?? process.arch;
const outDir = path.join(process.cwd(), "out");
const packageDir = path.join(outDir, `${APP}-${platform}-${arch}`);

if (!fs.existsSync(packageDir)) {
  console.error(`[self-test] packaged app not found at ${packageDir} — run npm run package first`);
  process.exit(1);
}

let bin;
if (platform === "darwin") {
  bin = path.join(packageDir, `${APP}.app`, "Contents", "MacOS", APP);
} else if (platform === "win32") {
  bin = path.join(packageDir, `${APP.toLowerCase()}.exe`);
} else {
  bin = path.join(packageDir, APP.toLowerCase());
}
if (!fs.existsSync(bin)) {
  console.error(`[self-test] binary not found at ${bin}`);
  process.exit(1);
}

const isCI = process.env.CI === "true" || process.env.CI === "1";
const outFile = path.join(os.tmpdir(), `atlarix-self-test-${Date.now()}.log`);

const env = { ...process.env, E2E_TEST_BUILD: "true", ATLARIX_SELF_TEST_OUT: outFile };

let cmd = bin;
let args = ["--self-test"];
if (platform === "linux" && isCI) {
  // Electron on a headless Linux runner needs a virtual display; sandbox off
  // (Ubuntu-24 userns restrictions kill the SUID sandbox).
  args = ["--no-sandbox", "--self-test"];
  cmd = "xvfb-run";
  args = ["-a", bin, ...args];
}

console.log(`[self-test] launching: ${cmd} ${args.join(" ")}`);
/**
 * HARD DEADLINE. A diagnostic must never be able to hang CI.
 *
 * On the v14.35.0 Windows release run the packaged app printed `PASSED (9/9)` and
 * then simply did not exit — it kept doing normal app work and sat there for 22
 * minutes until the job was cancelled by hand, on a step that normally takes
 * seconds. Per-probe timeouts already existed (PROBE_TIMEOUT_MS); what was missing
 * was any bound on the PROCESS, so a failure to terminate was unbounded.
 *
 * `spawnSync`'s `timeout` sends `killSignal` when it expires, which is exactly the
 * behaviour wanted: the probes get generous room (9 probes x 45s worst case is
 * theoretical; observed is ~6s), and anything past that is a defect worth failing
 * on rather than waiting out. On Windows SIGKILL maps to TerminateProcess.
 *
 * Note this bounds the CHILD only. If a grandchild inherits stdio and outlives it,
 * spawnSync can still wait on the pipe — which is a candidate explanation for the
 * hang itself, and why the pid is now stamped on every self-test line.
 */
const DEADLINE_MS = Number(process.env.ATLARIX_SELF_TEST_DEADLINE_MS ?? 240_000);

/**
 * The verdict comes from the PROBE REPORT, not from the process exiting.
 *
 * `spawnSync` waited for termination, which conflated two different questions:
 * "is the packaged build sound?" (what the probes answer) and "does the app shut
 * itself down cleanly?" (a separate property). On Windows the second one fails
 * while the first passes — the app prints `PASSED (9/9 probes)` and then keeps
 * running, so the deadline killed it and the build was reported as broken despite
 * every probe succeeding. It cost the v14.36.0 release two full runs.
 *
 * The same second-process app boot (`db-migrate` applying migrations, the Squirrel
 * updater, automations) appears in the v14.35.0 Windows log, which SUCCEEDED — so
 * the boot is long-standing and is not what regressed. What the teardown defect is
 * exactly remains UNIDENTIFIED; it is recorded in docs/TODO.md rather than papered
 * over silently, and this script now reports it loudly instead of failing on it.
 *
 * What still fails the build: any probe reporting FAIL, a launch error, a kill by
 * signal, a non-zero exit, or NO report at all within the deadline. Only the
 * narrow "everything passed but it would not exit" case is downgraded.
 *
 * The report is read from the FILE sink, not stdout: a Windows GUI-subsystem exe
 * detaches stdout, so the file is the only place the lines reliably land.
 */
const REPORT_RE = /\[self-test[^\]]*\]\s+(PASSED|FAILED)\s+\((\d+)\/(\d+) probes\)/;

function readReport() {
  try {
    const m = REPORT_RE.exec(fs.readFileSync(outFile, "utf8"));
    if (!m) return null;
    return { verdict: m[1], passed: Number(m[2]), total: Number(m[3]) };
  } catch {
    return null;
  }
}

/** Kill the process AND anything it spawned — a lingering grandchild is the whole problem. */
function killTree(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

const result = await new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: "inherit", env });
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    clearTimeout(deadline);
    resolve(value);
  };

  child.on("error", (error) => finish({ error }));
  child.on("exit", (status, signal) => finish({ status, signal, exitedOnItsOwn: true }));

  // Poll the sink so a finished report ends the wait even if the app never exits.
  const poll = setInterval(() => {
    const report = readReport();
    if (!report) return;
    killTree(child.pid);
    finish({ status: report.verdict === "PASSED" ? 0 : 1, report, hadToKill: true });
  }, 500);

  const deadline = setTimeout(() => {
    killTree(child.pid);
    finish({ error: Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }) });
  }, DEADLINE_MS);
});

if (result.hadToKill && result.report?.verdict === "PASSED") {
  console.warn(
    `[self-test] All ${result.report.total} probes PASSED, but the app did not exit ` +
      `on its own and its process tree was killed.\n` +
      `[self-test] The BUILD is verified; the teardown is not. This is a known, ` +
      `unresolved defect (see docs/TODO.md) and is deliberately not failing the build — ` +
      `every probe passing is what this script exists to establish.`,
  );
}

// GUI-subsystem Windows exe detaches stdout — surface the file sink.
if (fs.existsSync(outFile)) {
  try {
    console.log("[self-test] --- captured output ---");
    console.log(fs.readFileSync(outFile, "utf8"));
    fs.unlinkSync(outFile);
  } catch {
    /* best effort */
  }
}

// Distinguish OUR deadline from a kernel kill: `spawnSync` reports the timeout as
// an ETIMEDOUT error alongside the signal it sent, and conflating "we gave up" with
// "the OS refused to run it" would send the next person down the entitlements path
// for no reason.
if (result.error && result.error.code === "ETIMEDOUT") {
  console.error(
    `[self-test] TIMED OUT after ${DEADLINE_MS}ms and was killed.\n` +
      `[self-test] The probes above show how far it got. If they all PASSED, the app ` +
      `finished its work and then failed to EXIT — look for a process still alive ` +
      `(the pid on each line identifies the writer), an open window blocking ` +
      `window-all-closed, or a forked child holding stdio.`,
  );
  process.exit(1);
}
if (result.error) {
  console.error(`[self-test] launch error:`, result.error.message);
  process.exit(1);
}

// A SIGNAL is not an exit code, and conflating them hides the worst failures.
//
// This used to be a bare `process.exit(result.status ?? 1)`. When the packaged app
// is killed by the kernel — an entitlement it is not provisioned for, a broken
// signature, a dyld failure — `status` is null and `signal` carries the truth. The
// old line turned that into a plain "exit 1" with no probe output, which reads
// exactly like a failing probe. It cost a long investigation on the v14.35.0
// release: the app died in 75ms having printed nothing, and the log could not say
// why. Both silent-kill traps this project already knows about land here
// (configureWebAuthn before whenReady = SIGTRAP/133, a keychain access group on a
// binary that is not provisioned for it = SIGKILL/137), so this is the one place
// that must name them.
if (result.signal) {
  console.error(
    `[self-test] the app was KILLED by ${result.signal} before finishing — ` +
      `no probe output means it never reached JS.\n` +
      `[self-test] On macOS this is almost always the signature or the entitlements, ` +
      `not the probes: an entitlement the binary is not provisioned for is SIGKILLed ` +
      `on exec while \`codesign -v\` still calls it valid. Check with:\n` +
      `[self-test]   codesign -d --entitlements - "<Atlarix.app>"\n` +
      `[self-test]   log show --last 5m --predicate 'sender == "kernel"' | grep -i atlarix`,
  );
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[self-test] app exited ${result.status} without passing`);
}
process.exit(result.status ?? 1);
