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
process.exit(result.status ?? 1);
