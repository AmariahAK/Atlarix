/**
 * The app must not hardcode a V8 heap ceiling.
 *
 * `src/main.ts` shipped this from v8.0.4 (03e51978) for four months:
 *
 *   // Raise V8 old-space ceiling before Chromium hits partition_alloc hard OOM
 *   app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
 *
 * It never did that. Measured with a bare Electron probe on an 8 GB machine,
 * reading `v8.getHeapStatistics().heap_size_limit` in main and
 * `performance.memory.jsHeapSizeLimit` in a renderer:
 *
 *   flag                       main        renderer
 *   (none)                     4192 MB     3586 MB
 *   --max-old-space-size=4096  4192 MB     3586 MB   ← asked to RAISE: no change
 *   --max-old-space-size=256   4192 MB      368 MB   ← asked to LOWER: applied
 *
 * Main ignores the flag outright (a no-op once the isolate exists, and main's
 * already runs by then). The renderer honours it only DOWNWARD — so on a machine
 * whose adaptive default exceeds 4096 the line would cap the renderer, the exact
 * opposite of its stated purpose.
 *
 * Chromium/V8 already size the heap from physical memory, which is the dynamic
 * behaviour a hardcoded number destroys. This guards the deletion, because the
 * line reads as a sensible precaution and the obvious response to an OOM report
 * is to put it back.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Source with block comments stripped, so the docs explaining this may quote it. */
function executableSource(relPath: string): string {
  const raw = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("no hardcoded V8 heap ceiling ships to users", () => {
  it("main.ts sets no js-flags heap switch", () => {
    const code = executableSource("src/main.ts");
    expect(code).not.toMatch(/appendSwitch\(\s*["']js-flags["']/);
    expect(code).not.toContain("max-old-space-size");
  });

  it("no other main-process file sets one either", () => {
    // The deletion is worth nothing if it reappears one directory over.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), {
        withFileTypes: true,
      })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__")
            continue;
          walk(rel);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          if (
            /max-old-space-size|max_old_space_size/.test(executableSource(rel))
          ) {
            offenders.push(rel);
          }
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("the explanation stays with the deletion", () => {
    // A bare removal invites a well-meaning revert the next time someone reports
    // an OOM. The measured table is the thing that prevents it, so require it to
    // still be there.
    const raw = fs.readFileSync(path.join(ROOT, "src/main.ts"), "utf8");
    expect(raw).toContain("max-old-space-size");
    expect(raw).toMatch(/asked to RAISE/);
    expect(raw).toMatch(/asked to LOWER/);
  });
});
