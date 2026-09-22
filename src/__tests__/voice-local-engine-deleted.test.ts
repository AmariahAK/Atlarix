/**
 * The on-device speech engine must stay deleted.
 *
 * It ran whisper-small (transformers.js + onnxruntime-web) in the RENDERER, and
 * `useVoiceInput` warmed it whenever a composer MOUNTED with the local provider —
 * which was the default. Measured on an 8 GB Mac, one second after that warm
 * began:
 *
 *   idle   total   550 MB   renderer   149 MB   cpu   0%
 *   +1s    total 1,861 MB   renderer 1,530 MB   cpu 508%
 *
 * ~285 MB of weights plus WebGPU shader compilation, thirteen seconds of
 * multi-core saturation, at the moment a session opened — whether or not the
 * microphone was ever touched. The app's own crash snapshot recorded
 * `systemMemoryUsageMB: 7885 / 8192`. It took the whole machine down twice.
 *
 * The first fix moved the warm out of the mount effect, and that test lived here.
 * It is replaced rather than kept, because the engine is now gone entirely and
 * "it only loads 285 MB when you press the mic" is no longer the property worth
 * pinning. What is worth pinning is that it cannot come back by accident: the
 * dependency is heavy, the failure is invisible until a low-memory machine runs
 * out, and re-adding it is a two-line import away.
 *
 * Asserts the TREE, not a module's behaviour — there is no behaviour left to
 * assert, which is the point.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** Every source file, so a re-introduction anywhere is caught, not just in voice/. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      sourceFiles(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe("the local speech engine is gone", () => {
  it("ships no whisper worker or config", () => {
    expect(
      fs.existsSync(path.join(ROOT, "src/lib/voice/whisper-worker.ts")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(ROOT, "src/lib/voice/whisper-config.ts")),
    ).toBe(false);
  });

  it("does not depend on transformers.js anywhere in package.json", () => {
    const pkg = JSON.parse(read("package.json")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      expect(Object.keys(pkg[field] ?? {})).not.toContain(
        "@huggingface/transformers",
      );
    }
  });

  it("no source file imports transformers.js or onnxruntime", () => {
    const offenders = sourceFiles("src").filter((f) =>
      /from\s+["'](@huggingface\/transformers|onnxruntime[^"']*)["']/.test(
        read(f),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("carries no patch for a package it no longer installs", () => {
    // The patch un-poisoned transformers.js's session-creation promise chain. It
    // is dead weight now, and patch-package FAILS on a patch whose package is
    // absent — which would break `postinstall` on a clean install.
    const patches = fs.existsSync(path.join(ROOT, "patches"))
      ? fs.readdirSync(path.join(ROOT, "patches"))
      : [];
    expect(patches.filter((p) => p.includes("huggingface"))).toEqual([]);
  });

  it("the renderer no longer asks the CSP for permission to compile WASM", () => {
    // The speech engine was the ONLY thing in the renderer that compiled WASM
    // (verified by grepping the built chunks for WebAssembly.instantiate), so
    // 'wasm-unsafe-eval' went with it. If a dependency needs it again, that is a
    // deliberate loosening and should fail here first.
    const main = read("src/main.ts");
    const directive = main.match(/"script-src[^"]*"/)?.[0];
    expect(directive).toBe(`"script-src 'self'"`);
  });
});

describe("dictation has a provider to go to, or it does not appear", () => {
  it("the recording hook reaches main for every transcript", () => {
    // Both routes live in main — it holds the keys and the provider routing.
    // Nothing in the renderer may transcribe on its own again.
    const src = read("src/hooks/useVoiceInput.ts");
    expect(src).toContain("transcribeAudioCloud");
    expect(src).toContain("transcribeAudioWithModel");
    expect(src).not.toContain("ensureWorker");
  });

  it("the button renders nothing when there is no route", () => {
    const src = read("src/components/chat/VoiceInputButton.tsx");
    expect(src).toContain("useVoiceCapability");
    expect(src).toMatch(/if\s*\(!route\)\s*return null;/);
  });
});
