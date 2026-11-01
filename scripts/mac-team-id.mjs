#!/usr/bin/env node
/**
 * Every Mach-O inside a macOS .app must carry OUR Team ID.
 *
 * `codesign --verify --deep` is not enough: it passed a bundle whose libffmpeg,
 * libEGL, libGLESv2, swiftshader, better-sqlite3 and node-pty were unsigned or
 * ad-hoc (a timestamp-service outage during `npm run make`, 2026-10-30). Such a
 * bundle crashes at load with a Team ID mismatch under the hardened runtime
 * (ai-47's libffmpeg crash). This checks each file on its own.
 *
 *   node scripts/mac-team-id.mjs <path/to/App.app>   exits 1 when any file is off
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TEAM_ID = "7VWW7N9R87";

// 32/64-bit Mach-O in either byte order, and universal (fat) binaries.
const MAGICS = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"]);

/** Whether these first bytes start a Mach-O file. */
export function isMachO(head) {
  return head.length >= 4 && MAGICS.has(head.subarray(0, 4).toString("hex"));
}

/** Every Mach-O file under `root` (symlinks are not followed: frameworks link to Versions/A). */
export function listMachO(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        const fd = fs.openSync(p, "r");
        const head = Buffer.alloc(4);
        try {
          fs.readSync(fd, head, 0, 4, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (isMachO(head)) found.push(p);
      }
    }
  };
  walk(root);
  return found;
}

/** What `codesign -dv` says signed this file: a Team ID, "adhoc", "unsigned", or "unknown". */
export function parseCodesignDisplay(output) {
  if (/code object is not signed/i.test(output)) return "unsigned";
  if (/^Signature=adhoc$/m.test(output)) return "adhoc";
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  if (team === "not set") return "adhoc";
  return team || "unknown";
}

function codesignDisplay(file) {
  // codesign writes -d output to STDERR, even on success.
  const r = spawnSync("codesign", ["-dv", "--verbose=2", file], { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/**
 * The Mach-O files in `appPath` not signed by `team`, with what signed them.
 * `display` is codesign -dv's output for one file (injectable for tests).
 */
export function scanTeamIds(appPath, { team = TEAM_ID, display = codesignDisplay } = {}) {
  const files = listMachO(appPath);
  const off = [];
  for (const file of files) {
    const signer = parseCodesignDisplay(display(file));
    if (signer !== team) off.push({ file: path.relative(appPath, file), signer });
  }
  return { checked: files.length, off };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const app = process.argv[2];
  if (!app) {
    console.error("usage: node scripts/mac-team-id.mjs <path/to/App.app>");
    process.exit(2);
  }
  const { checked, off } = scanTeamIds(app);
  for (const { file, signer } of off) console.log(`${signer}\t${file}`);
  console.log(`${checked} Mach-O file(s) checked, ${off.length} without Team ID ${TEAM_ID}`);
  process.exit(off.length ? 1 : 0);
}
