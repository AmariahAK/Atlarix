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
    // ripgrep resolves and runs (grep/glob swallow rg errors, so probe directly).
    // Uses the bundled @vscode/ripgrep binary when present, else PATH `rg`.
    name: "ripgrep",
    run: async () => {
      const { promisify } = await import("node:util");
      const { execFile } = await import("node:child_process");
      const { resolveRipgrepPath } = await import("@/lib/tools/resolve-ripgrep");
      const rg = await resolveRipgrepPath();
      const { stdout } = await promisify(execFile)(rg, ["--version"]);
      if (!stdout.toLowerCase().includes("ripgrep")) {
        throw new Error(`unexpected rg output: ${stdout.slice(0, 60)}`);
      }
      return `${stdout.split("\n")[0]} (${rg === "rg" ? "PATH" : "bundled"})`;
    },
  },
  {
    // Shipped externals resolve their peer deps at runtime — @ai-sdk/* require
    // zod/v4, which a bad prune drops ("Cannot find module 'zod/v4'"). Load a
    // real model-provider factory to force that transitive resolution.
    //
    // v14.23.0: load the FACTORY MODULE rather than one SDK. Provider dispatch now
    // resolves through `provider-sdk-factories.ts`, which imports five SDKs at module
    // scope (openai, anthropic, google, xai, openai-compatible). Probing only
    // `@ai-sdk/google` would pass while a prune had dropped `@ai-sdk/xai` — and provider
    // dispatch fails SILENTLY (a request goes somewhere that answers, or throws deep in
    // a turn), so a packaged-only miss here is exactly the class worth catching at boot.
    name: "ai-sdk-deps",
    run: async () => {
      const mod = await import("@/ipc/shared/provider-sdk-factories");
      const names = Object.keys(mod.PROVIDER_SDK_FACTORIES);
      if (names.length === 0) {
        throw new Error("provider-sdk-factories loaded but the factory map is empty");
      }
      // Constructing one proves the SDK actually initialises, not merely that the
      // import resolved.
      const openaiCompatible = mod.PROVIDER_SDK_FACTORIES[mod.OPENAI_COMPATIBLE_NPM];
      if (typeof openaiCompatible !== "function") {
        throw new Error("openai-compatible factory missing");
      }
      openaiCompatible({
        providerId: "self-test",
        modelId: "probe",
        baseURL: "https://example.invalid/v1",
      });
      return `${names.length} provider SDK factories + zod/v4 resolvable`;
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
