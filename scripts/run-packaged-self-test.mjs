#!/usr/bin/env node
/**
 * Launch the packaged Atlarix binary with --self-test and propagate its exit
 * code. Run after verify-ci-package-out in each CI package job (and locally via
 * `npm run self-test:packaged`). Catches packaged-only failures the static
 * verifier can't: worker/native-module resolution inside the asar, node-pty
 * spawn. On Linux CI, wraps in xvfb-run (Electron whenReady needs a display
 * even though we exit before creating a window) and passes --no-sandbox.
 */
import { spawnSync } from "node:child_process";
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
const result = spawnSync(cmd, args, { stdio: "inherit", env });

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
