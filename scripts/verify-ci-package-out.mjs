#!/usr/bin/env node
/**
 * Fail fast when Electron Forge did not produce expected output (CI release builds).
 *
 * Windows CI uses ci:package + ci:installers (same as macOS/Linux); see docs/WINDOWS_RELEASE_CI.md.
 *
 * Usage:
 *   node scripts/verify-ci-package-out.mjs --stage make --platform darwin --arch arm64
 *   node scripts/verify-ci-package-out.mjs --stage package --platform linux --arch x64
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readBinaryArchs } from "./binary-arch.mjs";
import { argValue } from "./cli-args.mjs";

function parseArgs(argv) {
  // This script is the one that CAUGHT the arch mismatch, so it must never be the
  // one that mis-parses it. Both `--arch x64` and `--arch=x64` are accepted.
  return {
    stage: argValue(argv, "stage") ?? "make",
    platform: argValue(argv, "platform") ?? process.platform,
    arch: argValue(argv, "arch") ?? process.arch,
  };
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${n} B`;
}

/**
 * Coarse floor to catch a grossly broken/empty package (e.g. packageAfterPrune
 * skipped). The resource check (app.asar present) is the real
 * "packaging stages ran" assertion; this is only a backstop.
 *
 * History: v9.0.0 Setup.exe ~360 MiB. The v11 packaging fix (the asar was
 * silently bloated to 848 MiB by a packageAfterPrune `npm install` reconciling
 * the full dep tree — dugite/next/etc.) brought the LEGITIMATE installer down
 * to ~155 MiB with all required native assets still present. The old 200 MiB
 * floor predated that fix and now false-positives, so it's lowered to 100 MiB.
 */
const MIN_WIN_SETUP_BYTES = 100 * 1024 * 1024;

function verifyWindowsPackagedResources(packageDir) {
  const resourcesDir = path.join(packageDir, "resources");
  const appAsar = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(appAsar)) {
    return `missing ${path.relative(process.cwd(), appAsar)}`;
  }
  console.log(`OK: win32 resources app.asar`);
  return null;
}

function verifyWindowsSetupSize(makeFiles) {
  const setup = makeFiles.find(
    (f) =>
      f.toLowerCase().endsWith(".exe") && path.basename(f).includes("Setup"),
  );
  if (!setup) {
    return "no Setup.exe under out/make";
  }
  const bytes = fs.statSync(setup).size;
  console.log(`OK: ${path.basename(setup)} size=${formatBytes(bytes)}`);
  if (bytes < MIN_WIN_SETUP_BYTES) {
    return (
      `${path.basename(setup)} too small (${formatBytes(bytes)} < ${formatBytes(MIN_WIN_SETUP_BYTES)}); ` +
      "packageAfterPrune likely skipped — compare with v9.0.0 ~360 MiB"
    );
  }
  return null;
}

/**
 * EVERY `extraResource` THIS APP SHIPS, AND WHAT MUST BE TRUE OF IT.
 *
 * Until v14.43.0 this script asserted only that `resources/app.asar` exists — so
 * every bundled resource the app has ever had could have silently vanished from
 * `resources/` and the release would still have gone green. `extraResource` is
 * double-guarded in forge.config.ts (`process.platform === …` AND
 * `fs.existsSync(…)`), which is the right shape for a build that must not break —
 * and exactly why a missing input drops the resource with no error. This is the
 * assertion that closes that.
 *
 * The pre-existing entries are BACKFILLED here deliberately: they had the same gap.
 *
 *   platforms  which platforms must carry it
 *   minBytes   a floor. "Exists" is not enough — a 0-byte or few-byte file is a
 *              failed build whose artifact got copied, and the empty-#![cfg]-binary
 *              problem has already fooled this project once.
 *   exec       must have the POSIX exec bit. `extraResource` preserves mode, but a
 *              `cp` in a build script may not, and the failure is an EACCES on a
 *              user's machine long after CI was green.
 *   arch       must contain code for the requested --arch. THE GUARD FOR THE
 *              native/.dist STALENESS HAZARD: those binaries are staged to one
 *              arch-agnostic path so forge can name them, and `npm run clean` does
 *              not touch native/.dist.
 *   optional   absence is a warning, not a failure (a capability that degrades).
 */
const EXPECTED_RESOURCES = [
  { name: "AGENTS.md", platforms: ["darwin", "win32", "linux"], minBytes: 500 },
  { name: "skills", platforms: ["darwin", "win32", "linux"], dir: true },
  {
    name: "app-update.yml",
    platforms: ["darwin", "win32", "linux"],
    minBytes: 200,
  },
  {
    name: "models-snapshot.json.gz",
    platforms: ["darwin", "win32", "linux"],
    minBytes: 10_000,
    // forge.config.ts guards on existsSync and the runbook calls regenerating it a
    // nice-to-have (a stale snapshot self-heals on first refresh), so absence must
    // not fail a release.
    optional: true,
  },
  {
    name: "atlarix-sandbox.exe",
    platforms: ["win32"],
    minBytes: 20_000,
    arch: true,
    optionalEnv: "ALLOW_UNSANDBOXED_RELEASE",
  },
  {
    name: "atlarix-sandbox-linux",
    platforms: ["linux", "win32"], // win32 carries it for WSL confinement
    minBytes: 20_000,
    exec: true,
    // Piped from the build-linux job as an artifact, so on win32 it is an ELF and
    // the arch check would compare it against the Windows --arch. Skip arch there.
    archOn: ["linux"],
    optionalEnv: "ALLOW_UNSANDBOXED_RELEASE",
  },
  {
    // The Chrome native-messaging relay. NO `optionalEnv` and NO `optional`,
    // deliberately: it is the check whose absence let the bridge nearly ship
    // missing from every installer.
    //
    // `forge.config.ts` guards its extraResource entry on `fs.existsSync`, so a
    // runner that never built the crate contributes nothing and packaging
    // SUCCEEDS. At runtime `resolveRelayPath()` then returns null, the app logs
    // "no relay binary in this build" to a file nobody reads, and the bridge is
    // permanently dead in a release that looks completely healthy. Shipping it
    // dormant is a decision; shipping it absent is a defect, and from outside
    // the two are identical.
    name: "atlarix-bridge",
    platforms: ["darwin", "linux"],
    minBytes: 100_000,
    exec: true,
    arch: true,
  },
  {
    name: "atlarix-bridge.exe",
    platforms: ["win32"],
    minBytes: 100_000,
    arch: true,
  },
];

/** Where extraResource lands, which is platform-specific on darwin only. */
function resourcesDirFor(packageDir, platform, appName) {
  return platform === "darwin"
    ? path.join(packageDir, `${appName}.app`, "Contents", "Resources")
    : path.join(packageDir, "resources");
}

/**
 * `codesign -v --strict` on each new nested binary, plus an entitlements dump.
 *
 * NECESSARY BUT NOT SUFFICIENT, and that has to be said out loud: v14.35.0 shipped
 * a bundle that passed `codesign -v` and that the kernel SIGKILLed on exec, because
 * a PROVISIONED entitlement had reached a nested binary. The sufficient check is
 * launching the packaged app and confirming a nested binary execs without the
 * kernel killing it — a signature check alone cannot see a provisioned entitlement.
 */
function verifySignature(file) {
  try {
    execFileSync("codesign", ["-v", "--strict", file], { stdio: "pipe" });
  } catch (e) {
    const detail = String(e.stderr ?? e.message ?? "")
      .trim()
      .slice(0, 300);
    return `codesign -v --strict failed for ${path.basename(file)}: ${detail}`;
  }
  try {
    const ents = execFileSync("codesign", ["-d", "--entitlements", "-", file], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "latin1",
    });
    // The one thing that must never appear on a nested binary.
    if (/keychain-access-groups|temporary-exception/.test(ents)) {
      return `${path.basename(file)} carries a PROVISIONED entitlement — this is the v14.35.0 SIGKILL class`;
    }
  } catch {
    // No entitlements to dump is fine.
  }
  return null;
}

function verifyExpectedResources(
  packageDir,
  platform,
  arch,
  appName,
  { signed },
) {
  const dir = resourcesDirFor(packageDir, platform, appName);
  if (!fs.existsSync(dir))
    return [`missing resources dir ${path.relative(process.cwd(), dir)}`];

  const errors = [];
  for (const spec of EXPECTED_RESOURCES) {
    if (!spec.platforms.includes(platform)) continue;
    const target = path.join(dir, spec.name);
    const waived = spec.optionalEnv && process.env[spec.optionalEnv] === "1";

    if (!fs.existsSync(target)) {
      const msg = `missing resource ${spec.name} in ${path.relative(process.cwd(), dir)}`;
      if (spec.optional || waived) {
        console.log(
          `::warning::[verify-ci-package-out] ${msg}${waived ? ` (waived by ${spec.optionalEnv}=1)` : ""}`,
        );
      } else {
        errors.push(
          `${msg}. extraResource is guarded on existsSync in forge.config.ts, so a missing ` +
            `BUILD INPUT drops it silently — check the build step for this helper ran.`,
        );
      }
      continue;
    }

    const st = fs.statSync(target);
    if (spec.dir) {
      if (!st.isDirectory()) errors.push(`${spec.name} is not a directory`);
      console.log(`OK: resource ${spec.name}/`);
      continue;
    }

    if (spec.minBytes && st.size < spec.minBytes) {
      errors.push(
        `${spec.name} is ${st.size} bytes, below the ${spec.minBytes} floor — a truncated or ` +
          `empty artifact from a failed build`,
      );
      continue;
    }
    if (spec.exec && platform !== "win32" && !(st.mode & 0o111)) {
      errors.push(
        `${spec.name} is not executable (mode ${(st.mode & 0o777).toString(8)})`,
      );
      continue;
    }

    const wantArch =
      spec.arch || (spec.archOn && spec.archOn.includes(platform));
    let archNote = "";
    if (wantArch) {
      try {
        const archs = readBinaryArchs(target);
        if (!archs.includes(arch)) {
          errors.push(
            `${spec.name} is ${archs.join("+")} but --arch ${arch} was requested. A stale ` +
              `native/.dist from another arch is the usual cause; npm run clean does not remove it.`,
          );
          continue;
        }
        archNote = `, ${archs.join("+")}`;
      } catch (e) {
        errors.push(`${spec.name}: ${e.message}`);
        continue;
      }
    }

    if (signed && platform === "darwin" && (spec.arch || spec.exec)) {
      const sigErr = verifySignature(target);
      if (sigErr) {
        errors.push(sigErr);
        continue;
      }
      archNote += ", signed";
    }

    console.log(
      `OK: resource ${spec.name} (${formatBytes(st.size)}${archNote})`,
    );
  }
  return errors;
}

async function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function main() {
  const { stage, platform, arch } = parseArgs(process.argv);
  const root = process.cwd();
  const outDir = path.join(root, "out");
  const appName = "Atlarix";

  console.log(
    `[verify-ci-package-out] stage=${stage} platform=${platform} arch=${arch}`,
  );

  if (!fs.existsSync(outDir)) {
    await fail(
      `Missing out/ after ${stage}. Search logs for [packageAfterPrune], [win-ci-package], or electron-forge Finalizing package.`,
    );
  }

  const packageDir = path.join(outDir, `${appName}-${platform}-${arch}`);
  if (!fs.existsSync(packageDir)) {
    const entries = fs.readdirSync(outDir);
    await fail(
      `Missing packaged app at ${packageDir}. Found under out/: ${entries.join(", ") || "(empty)"}`,
    );
  }

  if (platform === "darwin") {
    const appBundle = path.join(packageDir, `${appName}.app`);
    if (!fs.existsSync(appBundle)) {
      const entries = fs.readdirSync(packageDir);
      await fail(
        `Missing ${appName}.app under ${packageDir}. Found: ${entries.join(", ") || "(empty)"}`,
      );
    }
  }

  if (platform === "win32") {
    const resourceErr = verifyWindowsPackagedResources(packageDir);
    if (resourceErr) {
      await fail(resourceErr);
    }
  }

  // Signature checks only make sense once signing has run, which on darwin means
  // an identity was available. Absent one (a local unsigned build), skip them
  // rather than failing on an ad-hoc signature.
  const signed = platform === "darwin" && !!process.env.APPLE_TEAM_ID;
  const resourceErrors = verifyExpectedResources(
    packageDir,
    platform,
    arch,
    appName,
    { signed },
  );
  if (resourceErrors.length) {
    for (const e of resourceErrors)
      console.error(`::error::[verify-ci-package-out] ${e}`);
    await fail(
      `${resourceErrors.length} expected resource(s) missing or invalid — see above`,
    );
  }

  if (stage === "make") {
    const makeDir = path.join(outDir, "make");
    if (!fs.existsSync(makeDir)) {
      await fail(
        `Missing out/make after make (packaged dir exists at ${packageDir}). Makers did not run — check hook.postMake in logs.`,
      );
    }
    const files = listFilesRecursive(makeDir);
    if (files.length === 0) {
      await fail("out/make exists but contains no distributable files");
    }
    console.log(`OK: ${files.length} file(s) under out/make`);
    for (const f of files.slice(0, 8)) {
      console.log(`  - ${path.relative(root, f)}`);
    }
    if (files.length > 8) console.log(`  ... and ${files.length - 8} more`);

    if (platform === "win32") {
      const sizeErr = verifyWindowsSetupSize(files);
      if (sizeErr) {
        await fail(sizeErr);
      }
    }
  }

  console.log(`OK: packaged app at ${packageDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
