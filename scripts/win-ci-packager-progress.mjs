/**
 * Heartbeat logging while @electron/packager runs on Windows CI.
 */
import fs from "node:fs";
import path from "node:path";

const PREFIX = "[win-packager-heartbeat]";

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function dirSizeBytes(target) {
  let total = 0;
  if (!fs.existsSync(target)) return 0;
  const st = fs.statSync(target);
  if (!st.isDirectory()) return st.size;
  const stack = [target];
  let files = 0;
  const maxFiles = 50_000;
  while (stack.length > 0 && files < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files >= maxFiles) break;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          total += fs.statSync(full).size;
          files++;
        }
      } catch {
        /* skip */
      }
    }
  }
  return total;
}

function findPackagerTemplateDir(packagerTmp) {
  const ep = path.join(packagerTmp, "electron-packager");
  if (!fs.existsSync(ep)) return null;
  try {
    const templates = fs
      .readdirSync(ep)
      .filter((n) => n.includes("template"))
      .map((n) => path.join(ep, n));
    if (templates.length === 0) return null;
    templates.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
    return templates[0];
  } catch {
    return null;
  }
}

/**
 * @param {string} tag
 * @param {{ outDir: string, packagerTmp: string, packageDir: string, startedAt: number, maxMs: number }} ctx
 */
export function logPackagerHeartbeat(tag, ctx) {
  const elapsedSec = ((Date.now() - ctx.startedAt) / 1000).toFixed(0);
  const template = findPackagerTemplateDir(ctx.packagerTmp);
  const templateSize = template ? formatBytes(dirSizeBytes(template)) : "n/a";
  const outExists = fs.existsSync(ctx.outDir);
  const pkgExists = fs.existsSync(ctx.packageDir);
  const exe = path.join(ctx.packageDir, "atlarix.exe");
  console.log(
    `${PREFIX} [${tag}] elapsed=${elapsedSec}s | out/=${outExists} packageDir=${pkgExists} exe=${fs.existsSync(exe)} | template=${template ? path.basename(template) : "none"} size=${templateSize}`,
  );
  if (Date.now() - ctx.startedAt > ctx.maxMs) {
    console.error(
      `::error::[${tag}] packager exceeded ${(ctx.maxMs / 60_000).toFixed(0)}m without finishing (likely stuck copying/walking files on Windows)`,
    );
    process.exit(1);
  }
}
