/**
 * Packaged self-test (`--self-test`).
 *
 * CI's static package verifier checks that files EXIST; it can't catch the
 * packaged-only failures we hit this session — a worker/native module that
 * won't resolve from inside the asar, or a node-pty binding that's present but
 * can't spawn. This runs the REAL ship paths headlessly and exits 0/nonzero so
 * a package job fails loudly on either class.
 *
 * Each probe reuses the shipped module (not a reimplementation) so it tests
 * what users get, and is time-boxed so a hung step FAILS rather than hangs CI.
 */

import log from "electron-log";

const logger = log.scope("self-test");

export interface SelfTestProbe {
  name: string;
  /** Resolve a detail string on success; throw on failure. */
  run: () => Promise<string | void>;
}

export interface SelfTestReport {
  code: number;
  results: { name: string; ok: boolean; detail: string; ms: number }[];
}

const PROBE_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/** Marker split across args so the shell's command echo can't false-positive it. */
const MARK = ["atlarix", "selftest", "ok"].join("-");

const DEFAULT_PROBES: SelfTestProbe[] = [
  {
    // Native binding + unpacked spawn-helper/conpty.
    name: "pty-spawn",
    run: async () => {
      const nodePty = await import("@lydell/node-pty");
      const { getInteractiveShell } = await import("@/lib/shell/resolve-shell");
      const { file, args } = getInteractiveShell();
      const pty = nodePty.spawn(file, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });
      try {
        const seen = await new Promise<boolean>((resolve, reject) => {
          let buf = "";
          const timer = setTimeout(() => reject(new Error("no marker within 8s")), 8000);
          timer.unref?.();
          pty.onData((d: string) => {
            buf += d;
            if (buf.includes(MARK)) {
              clearTimeout(timer);
              resolve(true);
            }
          });
          // `printf` avoids the marker appearing only in the command echo.
          pty.write(`printf '%s\\n' ${MARK}\r`);
        });
        if (!seen) throw new Error("marker not observed");
        return `spawned ${file}, marker observed`;
      } finally {
        try {
          pty.kill();
        } catch {
          /* already gone */
        }
      }
    },
  },
  {
    // Worker resolves from app.asar.unpacked/.vite/build (the ast-grep-class bug).
    name: "proxy-worker",
    run: async () => {
      const { startProxy } = await import("@/ipc/utils/start_proxy_server");
      const started = new Promise<string>((resolve) => {
        void startProxy("http://127.0.0.1:9", { onStarted: (url) => resolve(url) }).then(
          (worker) => {
            // Terminate once started; the started promise resolves independently.
            started.then(() => void worker.terminate());
          },
        );
      });
      const url = await started;
      return `proxy worker started (${url})`;
    },
  },
  {
    // ripgrep reachable on PATH (grep tool swallows rg errors, so probe directly).
    name: "ripgrep",
    run: async () => {
      const { promisify } = await import("node:util");
      const { execFile } = await import("node:child_process");
      const { stdout } = await promisify(execFile)("rg", ["--version"]);
      if (!stdout.toLowerCase().includes("ripgrep")) {
        throw new Error(`unexpected rg output: ${stdout.slice(0, 60)}`);
      }
      return stdout.split("\n")[0];
    },
  },
  {
    // Shipped externals resolve their peer deps at runtime — @ai-sdk/* require
    // zod/v4, which a bad prune drops ("Cannot find module 'zod/v4'"). Load a
    // real model-provider factory to force that transitive resolution.
    name: "ai-sdk-deps",
    run: async () => {
      const mod = await import("@ai-sdk/google");
      if (typeof mod.createGoogleGenerativeAI !== "function") {
        throw new Error("@ai-sdk/google loaded but factory missing");
      }
      return "@ai-sdk/google + zod/v4 resolvable";
    },
  },
];

export async function runSelfTest(probes: SelfTestProbe[] = DEFAULT_PROBES): Promise<SelfTestReport> {
  const results: SelfTestReport["results"] = [];
  const fs = await import("node:fs");
  const outFile = process.env.ATLARIX_SELF_TEST_OUT;
  const emit = (line: string) => {
    // eslint-disable-next-line no-console
    console.log(line);
    if (outFile) {
      try {
        fs.appendFileSync(outFile, line + "\n");
      } catch {
        /* best effort */
      }
    }
  };

  for (const probe of probes) {
    const t0 = Date.now();
    try {
      const detail = (await withTimeout(probe.run(), PROBE_TIMEOUT_MS, probe.name)) ?? "";
      const ms = Date.now() - t0;
      results.push({ name: probe.name, ok: true, detail, ms });
      emit(`[self-test] ${probe.name}: OK (${ms}ms) ${detail}`);
    } catch (e) {
      const ms = Date.now() - t0;
      const detail = e instanceof Error ? e.message : String(e);
      results.push({ name: probe.name, ok: false, detail, ms });
      emit(`[self-test] ${probe.name}: FAIL (${ms}ms) ${detail}`);
      logger.error(`self-test probe "${probe.name}" failed:`, e);
    }
  }

  const failures = results.filter((r) => !r.ok).length;
  emit(`[self-test] ${failures ? "FAILED" : "PASSED"} (${results.length - failures}/${results.length} probes)`);
  return { code: failures ? 1 : 0, results };
}
