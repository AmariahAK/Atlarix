#!/usr/bin/env node
/**
 * Assert that node-gyp can actually FIND a Visual Studio install, and say which.
 *
 * WHY THIS EXISTS: `@electron/node-gyp@10.2.0-electron.1` maps VS majors to years
 * and gives up on anything newer than 17. `windows-latest` resolves to
 * `windows-2025-vs2026`, whose only Visual Studio is 2026 (major 18), so the finder
 * locates it, logs `unsupported version: 18`, falls through every older check, and
 * reports "Could not find any Visual Studio installation to use" on a machine that
 * plainly has one. `patches/@electron+node-gyp+10.2.0-electron.1.patch` teaches it
 * 18 -> 2026; this script is how we know the patch is still applied and working.
 *
 * WHY NOT JUST GREP THE BUILD LOG, which is what the workflow comments used to ask
 * for: `@electron/rebuild` forks node-gyp and BUFFERS its stdout+stderr, printing it
 * only when the child exits non-zero. On a green build there is no log to grep, so
 * "assert the absence of `unsupported version: 18`" is trivially satisfied and
 * proves nothing. This calls the finder directly instead and asserts on its return
 * value, which cannot be vacuous.
 *
 * It needs no compiler and takes about a second, so it runs BEFORE the ~20-minute
 * native build and turns a late, confusingly-worded failure into an immediate named
 * one.
 *
 * Non-Windows hosts exit 0 with a skip line: there is nothing to find.
 */
import { createRequire } from "node:module";

const TAG = "check-vs-toolchain";
const require = createRequire(import.meta.url);

if (process.platform !== "win32") {
  console.log(`[${TAG}] skipped — ${process.platform}, not win32.`);
  process.exit(0);
}

let VisualStudioFinder;
try {
  // The PATCHED module. Resolving it through the real dependency graph is
  // deliberate: if patch-package silently stopped applying (a version bump, a
  // failed postinstall), this is the copy the build will use too.
  VisualStudioFinder = require("@electron/node-gyp/lib/find-visualstudio");
} catch (err) {
  console.error(
    `[${TAG}] could not load @electron/node-gyp's VS finder: ${err.message}`,
  );
  console.error(
    `[${TAG}] run \`npm ci\` first — the patch is applied by postinstall.`,
  );
  process.exit(1);
}

// `nodeSemver` only gates the VS2015/2017 fallbacks by major version. The finder
// never uses the minor or patch, so the running Node's major is the honest value.
const nodeSemver = { major: Number(process.versions.node.split(".")[0]) };

let info;
try {
  info = await VisualStudioFinder.findVisualStudio(nodeSemver, undefined);
} catch (err) {
  // The finder replays its whole diagnostic log at error level before throwing, so
  // the reason is already on stderr above this line.
  console.error(`[${TAG}] FAIL — ${err.message}`);
  process.exit(1);
}

console.log(`[${TAG}] versionYear : ${info?.versionYear}`);
console.log(`[${TAG}] version     : ${info?.version}`);
console.log(`[${TAG}] toolset     : ${info?.toolset}`);
console.log(`[${TAG}] sdk         : ${info?.sdk}`);
console.log(`[${TAG}] msBuild     : ${info?.msBuild}`);
console.log(`[${TAG}] path        : ${info?.path}`);

const problems = [];
if (!info?.versionYear) {
  problems.push(
    "no versionYear — the major->year map does not cover this install",
  );
}
// `toolset` is the SOLE source of <PlatformToolset> in the generated .vcxproj, and
// nothing downstream of node-gyp validates it. A falsy value here means node-gyp
// would have discarded the install entirely ("- missing any VC++ toolset").
if (!info?.toolset) {
  problems.push("no toolset — <PlatformToolset> would be unset");
}
if (!info?.msBuild) {
  problems.push("no msBuild path");
}
if (!info?.sdk) {
  problems.push("no Windows SDK");
}

if (problems.length > 0) {
  for (const p of problems) {
    console.error(`[${TAG}] FAIL — ${p}`);
  }
  process.exit(1);
}

console.log(
  `[${TAG}] OK — VS${info.versionYear} (${info.version}), toolset ${info.toolset}.`,
);
