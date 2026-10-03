/**
 * `tiktoken/lite` for the compiled CLI. The package finds its wasm through
 * `__dirname`, which Bun freezes to the BUILD machine's path, so on any other
 * machine it throws "Missing tiktoken_bg.wasm" at import. Same initialisation,
 * reading the copy embedded in the binary.
 */
import fs from "node:fs";
import { assets } from "atlarix:assets";
// eslint-disable-next-line @typescript-eslint/no-require-imports
// By file path: the package's `exports` map does not expose this subpath.
const wasm = require("../../node_modules/tiktoken/lite/tiktoken_bg.cjs");

const bytes = fs.readFileSync(assets.tiktokenWasm!);
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
  "./tiktoken_bg.js": wasm,
});
wasm.__wbg_set_wasm(instance.exports);

export const Tiktoken = wasm.Tiktoken;
