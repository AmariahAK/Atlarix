/**
 * The QuickJS engine mods run in must ship in EVERY build. Its JS is bundled;
 * its .wasm is a separate file that bundlers move away from — the shape of the
 * ONNX int8 trap, where the WASM path worked in development and nowhere else.
 *
 * Each check reads the build's own configuration, so dropping the file from one
 * build fails here instead of on a user's machine.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const WASM =
  "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("the QuickJS wasm ships in every build", () => {
  it("exists where every build takes it from", () => {
    const bytes = fs.readFileSync(path.join(root, WASM));
    // `\0asm`: a real WebAssembly binary, not a stub.
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });

  it("is embedded in the compiled CLI and published to mod-host", () => {
    expect(read("scripts/bun-cli-plugin.ts")).toContain(
      `quickjsWasm: path.join(root, "${WASM}")`,
    );
    expect(read("src/headless/bundled-assets.ts")).toContain(
      'set("ATLARIX_QUICKJS_WASM", assets.quickjsWasm);',
    );
  });

  it("ships beside the headless bundle and in its npm package", () => {
    const headless = read("scripts/build-headless.mjs");
    expect(headless).toContain(WASM);
    expect(headless).toContain('dest: "quickjs.wasm"');
    expect(read("scripts/build-headless-npm.mjs")).toContain('"quickjs.wasm"');
    expect(read("src/runtime/assets-node.ts")).toContain(
      'quickjsWasm: shipped("quickjs.wasm")',
    );
  });

  it("is an extraResource of the packaged app, under the name mod-host reads", () => {
    const forge = read("forge.config.ts");
    const block = forge.slice(
      forge.indexOf("extraResource:"),
      forge.indexOf("]", forge.indexOf("extraResource:")),
    );
    expect(block).toContain(
      "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
    );
    expect(read("src/lib/plugins/mod-host.ts")).toContain(
      'path.join(process.resourcesPath, "emscripten-module.wasm")',
    );
  });

  it("boots from bytes alone, the way every build loads it", async () => {
    const saved = process.env.ATLARIX_QUICKJS_WASM;
    process.env.ATLARIX_QUICKJS_WASM = path.join(root, WASM);
    try {
      const { quickjsWasmPath } = await import("@/lib/plugins/mod-host");
      expect(quickjsWasmPath()).toBe(path.join(root, WASM));
      const { newQuickJSWASMModuleFromVariant, newVariant } = await import(
        "quickjs-emscripten-core"
      );
      const variant = (await import("@jitl/quickjs-wasmfile-release-sync"))
        .default;
      const bytes = fs.readFileSync(path.join(root, WASM));
      const qjs = await newQuickJSWASMModuleFromVariant(
        newVariant(variant, {
          wasmBinary: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        }),
      );
      const vm = qjs.newContext();
      const r = vm.evalCode("1 + 2");
      expect(vm.dump(vm.unwrapResult(r))).toBe(3);
      vm.dispose();
    } finally {
      if (saved === undefined) delete process.env.ATLARIX_QUICKJS_WASM;
      else process.env.ATLARIX_QUICKJS_WASM = saved;
    }
  });

  // A6: the packaged main is CommonJS and loads these through require(); their
  // ES-module entries need import.meta.url, which that bundle does not have.
  it("is external to the main bundle, so the packaged app loads its CommonJS build", () => {
    const vite = read("vite.main.config.mts");
    const list = vite.slice(
      vite.indexOf("mainRollupExternals"),
      vite.indexOf("];", vite.indexOf("mainRollupExternals")),
    );
    expect(list).toContain('"quickjs-emscripten-core"');
    expect(list).toContain('"@jitl/quickjs-wasmfile-release-sync"');
  });

  it("boots through require() alone, as the packaged main loads it", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = `
      const fs = require("node:fs");
      const core = require("quickjs-emscripten-core");
      const variant = require("@jitl/quickjs-wasmfile-release-sync").default;
      const bytes = fs.readFileSync(process.argv[1]);
      core.newQuickJSWASMModuleFromVariant(
        core.newVariant(variant, { wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
      ).then((qjs) => {
        const vm = qjs.newContext();
        process.stdout.write(String(vm.dump(vm.unwrapResult(vm.evalCode("6 * 7")))));
        vm.dispose();
      }, (e) => { process.stderr.write(String(e)); process.exit(1); });
    `;
    const r = spawnSync(
      process.execPath,
      ["-e", script, path.join(root, WASM)],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("42");
  });
});
