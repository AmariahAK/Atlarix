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

const PROBE_TIMEOUT_MS = 45_000;

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

export const DEFAULT_PROBES: SelfTestProbe[] = [
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
          const timer = setTimeout(() => reject(new Error("no marker within 20s")), 20_000);
          timer.unref?.();
          pty.onData((d: string) => {
            buf += d;
            if (buf.includes(MARK)) {
              clearTimeout(timer);
              resolve(true);
            }
          });
          // PowerShell has no `printf`; `Write-Output` works there.
          // Bash/zsh have no `Write-Output`; `printf` works there.
          // Use the shell-appropriate command so both actually execute.
          const cmd = file.toLowerCase().includes("powershell")
            ? `Write-Output ${MARK}`
            : `printf '%s\\n' ${MARK}`;
          pty.write(`${cmd}\r`);
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
    // better-sqlite3 is the ONLY dependency genuinely pinned to the Electron ABI
    // — `@lydell/node-pty` is N-API and ships prebuilds, so `pty-spawn` above
    // passes whatever Electron we are on and proves nothing about the rebuild.
    // Without this probe an ABI mismatch (or a prune that loses the unpacked
    // `.node`) reaches the user as a blank window at first launch, because the
    // DB opens before anything is rendered.
    //
    // Proven by the 38 -> 43 upgrade: better-sqlite3 12.4.1 does not COMPILE
    // against V8 15 (`External::New` gained a required tag,
    // `PropertyCallbackInfo::This()` was removed), so this is a live failure
    // mode, not a hypothetical one.
    //
    // Uses a THROWAWAY database in tmp: the self-test deliberately runs without
    // the app's DB (no window, no GPU, no migrations), and opening the real one
    // here would take its lock and run migrations outside the app's own ordering.
    name: "sqlite",
    run: async () => {
      const os = await import("node:os");
      const fsp = await import("node:fs/promises");
      const path = await import("node:path");
      const { default: Database } = await import("better-sqlite3");

      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atlarix-selftest-db-"));
      const file = path.join(dir, "probe.db");
      try {
        const db = new Database(file);
        try {
          // Round-trip real data: loading the binding is not the same as it
          // working, and a half-broken build can import and then fail to query.
          db.pragma("journal_mode = WAL");
          db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
          db.prepare("INSERT INTO probe (v) VALUES (?)").run(MARK);
          const row = db.prepare("SELECT v FROM probe WHERE id = 1").get() as
            | { v?: string }
            | undefined;
          if (row?.v !== MARK) {
            throw new Error(`round-trip returned ${JSON.stringify(row)}`);
          }
          const sqlite = db.prepare("SELECT sqlite_version() AS v").get() as {
            v: string;
          };
          return `better-sqlite3 ok (sqlite ${sqlite.v}, ABI ${process.versions.modules})`;
        } finally {
          db.close();
        }
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
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
  {
    // REPORTER, not an assertion — it never fails. Added for the Microsoft Store
    // (MSIX) packaging spike, where the open question is not "does it work" but
    // "WHERE did the package container put things". Inside an MSIX the install
    // dir is read-only and AppData writes may be redirected into
    // %LOCALAPPDATA%\Packages\<PFN>\, which would mean a user moving from the
    // Squirrel build to the Store build silently gets a fresh profile — no
    // workspaces, no chats, no stored credentials. Diff this against a Squirrel
    // install to find out. Useful on every platform as a provenance record.
    name: "context",
    run: async () => {
      const { app } = await import("electron");
      const os = await import("node:os");
      const facts = {
        windowsStore: process.windowsStore === true,
        packaged: app.isPackaged,
        execPath: process.execPath,
        resources: process.resourcesPath,
        userData: app.getPath("userData"),
        temp: app.getPath("temp"),
        home: os.homedir(),
      };
      return Object.entries(facts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" | ");
    },
  },
  {
    // Can the app actually EXECUTE a command in a child process?
    //
    // `pty-spawn` above does not answer that on Windows. It writes
    // `printf '%s\n' <marker>` into a PowerShell pty, and PowerShell has no
    // `printf` — so the marker appears in PowerShell's ERROR text and the probe
    // goes green having executed nothing. That probe is still worth keeping (it
    // proves the node-pty binding loads, spawns, and streams), but the Store
    // spike needs proof that a command ran, so this asserts on the EXIT CODE and
    // on stdout from the non-interactive shell `run_command` actually uses.
    //
    // Matters for MSIX because child processes inherit the package identity by
    // default, and Node's child_process cannot opt out of that.
    name: "child-exec",
    run: async () => {
      const { promisify } = await import("node:util");
      const { execFile } = await import("node:child_process");
      const path = await import("node:path");
      const { getAcceptableShell, isCmdShell } = await import("@/lib/shell/resolve-shell");
      const run = promisify(execFile);

      const shell = getAcceptableShell();
      const base = (
        process.platform === "win32" ? path.win32.basename(shell) : path.basename(shell)
      ).toLowerCase();
      // cmd.exe takes /c and has no printf; POSIX shells (incl. Git bash on
      // Windows) take -c. Decided from the SHELL via the shared helper, never from
      // the platform — see the note on `isCmdShell`.
      const args = isCmdShell(shell)
        ? ["/c", `echo ${MARK}`]
        : ["-c", `printf '%s\\n' ${MARK}`];

      // Rejects on a non-zero exit, which is the assertion that matters here.
      const { stdout } = await run(shell, args, { windowsHide: true });
      if (!stdout.includes(MARK)) {
        throw new Error(`${base} exited 0 but did not emit the marker: ${stdout.slice(0, 120)}`);
      }

      // An external dev tool, best-effort: a bare test machine may genuinely
      // have no git, and failing the probe for that would be a false alarm. The
      // point is to surface HOW git resolves from inside the package container.
      let git = "git=absent";
      try {
        const { stdout: gitOut } = await run("git", ["--version"], { windowsHide: true });
        git = `git=${gitOut.trim()}`;
      } catch (e) {
        git = `git=unavailable (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`;
      }

      return `${base} executed the command, marker on stdout | ${git}`;
    },
  },
  {
    // Can the app read/write outside its own container?
    //
    // Atlarix is useless if it cannot touch the user's source trees, and an MSIX
    // package container is the one place that could silently prevent it. Writes
    // to the HOME directory, then reports the path it RESOLVED to — under
    // filesystem redirection the write succeeds but lands somewhere else, so the
    // resolved path is the actual finding, not the success.
    name: "fs-outside-container",
    run: async () => {
      const fsp = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");

      const target = path.join(os.homedir(), `.atlarix-self-test-${process.pid}`);
      await fsp.writeFile(target, MARK, "utf8");
      try {
        const readBack = await fsp.readFile(target, "utf8");
        if (readBack !== MARK) {
          throw new Error(`wrote ${MARK} but read back ${JSON.stringify(readBack.slice(0, 60))}`);
        }
        // realpath AFTER a successful write: this is where the bytes actually went.
        const resolved = await fsp.realpath(target);
        const redirected = path.dirname(resolved) !== os.homedir();
        return `wrote+read ${resolved}${redirected ? " (REDIRECTED away from homedir)" : ""}`;
      } finally {
        await fsp.rm(target, { force: true });
      }
    },
  },
  {
    /**
     * Does the run_command sandbox actually confine writes WITHOUT breaking the
     * toolchain?
     *
     * This probe exists because CI only ever ran `cargo build` on the sandbox
     * helpers — nothing executed them. The Windows helper therefore shipped for
     * several releases silently blocking `bash.exe` and git's `/dev/null`, because
     * AppContainer is deny-by-default on READS while our policy is "reads broad,
     * writes confined". Every assertion below maps to a real observed failure.
     *
     * It drives the SHIPPED path (`runShellCommandStreaming` → `wrapCommandInSandbox`
     * → spawn), so it tests what users get rather than a reimplementation.
     *
     * Differential where it matters: the read and toolchain checks compare
     * sandboxed against UNSANDBOXED behaviour, so "git isn't installed" can never
     * masquerade as "the sandbox blocked git".
     */
    name: "sandbox",
    run: async () => {
      const fsp = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const { runShellCommandStreaming } = await import("@/ipc/utils/runShellCommand");
      const { wrapCommandInSandbox } = await import("@/lib/sandbox/wrap-command");
      const { getAcceptableShell, isCmdShell } = await import("@/lib/shell/resolve-shell");

      // Command syntax follows the RESOLVED SHELL, never `process.platform`.
      //
      // On Windows `getAcceptableShell()` prefers Git bash when Git for Windows is
      // installed, so a platform check picks cmd syntax for a POSIX shell. The first
      // version of this probe branched on the platform and used `type` to read a
      // file — which in bash is a builtin meaning "describe a command", not "print a
      // file". It failed sandboxed AND unsandboxed, and the differential correctly
      // reported the probe environment as broken rather than blaming the sandbox.
      //
      // That is the same mistake the helper itself had (hardcoding `cmd.exe /c` while
      // unsandboxed runs used bash), made a second time in the test for it. Mirrors
      // `command_line_for()` in native/atlarix-sandbox/src/main.rs.
      const shell = getAcceptableShell();
      const isCmd = isCmdShell(shell);
      const home = os.homedir();
      // Both live directly in HOME: `defaultWritablePaths` grants specific home
      // SUBdirECTORIES (~/.npm, ~/.cache, …) but never HOME itself, so `outside`
      // is genuinely outside every writable root while `ws` is writable only
      // because it IS the workspace. Putting the workspace under tmpdir instead
      // would let the temp grant satisfy assertion 1 and prove nothing.
      const ws = path.join(home, `atlarix-sbx-ws-${process.pid}`);
      const outside = path.join(home, `atlarix-sbx-out-${process.pid}.txt`);

      await fsp.mkdir(ws, { recursive: true });
      await fsp.writeFile(outside, MARK, "utf8");

      /** Run `command` through the real sandbox path, rooted at the probe workspace. */
      const sandboxed = (command: string) =>
        runShellCommandStreaming(command, ws, {
          onOutput: () => {},
          workspaceRoot: ws,
          sandbox: { workspacePath: ws, readOnly: false },
        });
      /** Same command with no sandbox — the control arm of the differential. */
      const plain = (command: string) =>
        runShellCommandStreaming(command, ws, { onOutput: () => {}, workspaceRoot: ws });

      const notes: string[] = [];
      try {
        // A sandbox that isn't applied is the false-pass this probe exists to kill,
        // so report it as a FAILURE rather than skipping the assertions below.
        const wrapped = wrapCommandInSandbox({
          command: "exit 0",
          shell,
          workspacePath: ws,
        });
        if (!wrapped.sandboxed) {
          throw new Error(`sandbox not applied (${wrapped.note ?? "no reason given"})`);
        }

        // 1. Writes INSIDE the workspace must work, or the sandbox is unusable.
        const inside = await sandboxed(isCmd ? "echo x> inside.txt" : "printf x > inside.txt");
        if (inside.exitCode !== 0) {
          throw new Error(`write inside workspace FAILED (exit ${inside.exitCode}): ${inside.stderr.slice(0, 160)}`);
        }

        // 2. Writes OUTSIDE every writable root must be denied, or it confines nothing.
        const escaped = await sandboxed(
          isCmd ? `echo x> "${outside}"` : `printf x > "${outside}"`,
        );
        if (escaped.exitCode === 0) {
          throw new Error(`write OUTSIDE the workspace SUCCEEDED (${outside}) — writes are not confined`);
        }

        // 3. Reads outside must still work. THIS is the assertion that would have
        //    caught the AppContainer bug on the day the helper started shipping.
        const readCmd = isCmd ? `type "${outside}"` : `cat "${outside}"`;
        const readSandboxed = await sandboxed(readCmd);
        if (readSandboxed.exitCode !== 0) {
          const readPlain = await plain(readCmd);
          throw new Error(
            readPlain.exitCode === 0
              ? `read outside the workspace is BLOCKED by the sandbox (works unsandboxed) — deny-by-default on reads`
              : `read outside failed both sandboxed and unsandboxed; probe environment is broken, not the sandbox`,
          );
        }

        // 4. A non-system toolchain binary must be executable. On Windows this is
        //    `C:\Program Files\Git\`, which is exactly what returned
        //    "Access is denied" under AppContainer. Differential so a machine
        //    without git skips rather than fails.
        const gitPlain = await plain("git --version");
        if (gitPlain.exitCode !== 0) {
          notes.push("git=absent (toolchain exec assertion skipped)");
        } else {
          const gitSandboxed = await sandboxed("git --version");
          if (gitSandboxed.exitCode !== 0) {
            throw new Error(
              `git runs unsandboxed but FAILS sandboxed (exit ${gitSandboxed.exitCode}): ${gitSandboxed.stderr.slice(0, 160)}`,
            );
          }
          notes.push("git=exec ok");
        }

        // 5. `truncate(2)` is gated by a SEPARATE Landlock right (TRUNCATE, ABI V3)
        //    from WRITE_FILE, so a helper pinned to an older ABI confines `>` but
        //    not `truncate`. POSIX only — Windows has no equivalent utility.
        if (!isCmd) {
          const truncPlain = await plain(`truncate -s 0 "${outside}"`);
          if (truncPlain.exitCode !== 0) {
            notes.push("truncate=absent (assertion skipped)");
          } else {
            await fsp.writeFile(outside, MARK, "utf8"); // the control arm emptied it
            const truncSandboxed = await sandboxed(`truncate -s 0 "${outside}"`);
            if (truncSandboxed.exitCode === 0) {
              throw new Error(
                "truncate OUTSIDE the workspace SUCCEEDED — write confinement bypassable via truncate(2)",
              );
            }
            notes.push("truncate=denied");
          }
        }

        return `confined writes, reads+exec unrestricted${notes.length ? ` | ${notes.join(" | ")}` : ""}`;
      } finally {
        await fsp.rm(ws, { recursive: true, force: true });
        await fsp.rm(outside, { force: true });
      }
    },
  },
];

export async function runSelfTest(probes: SelfTestProbe[] = DEFAULT_PROBES): Promise<SelfTestReport> {
  const results: SelfTestReport["results"] = [];
  const fs = await import("node:fs");
  const outFile = process.env.ATLARIX_SELF_TEST_OUT;
  // The pid is on EVERY line deliberately. On the v14.35.0 Windows run this log
  // contained self-test output AND a full `onReady()` boot — which is impossible in
  // one process, since onReady is only called inside `if (!IS_SELF_TEST)`. Two
  // processes was the only consistent reading, and it could not be confirmed from
  // the log because nothing identified the writer. Now it does.
  const pid = process.pid;
  const emit = (line: string) => {
    line = line.replace("[self-test]", `[self-test pid=${pid}]`);
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
